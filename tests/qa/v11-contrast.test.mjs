import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { miniRepo, framemd5 } from '../render/helpers.mjs';
import { haveFfmpeg } from './helpers.mjs';
import { browserOk } from '../ci/browser.mjs';
import { launchBrowser } from '../../engine/render/lib/gpu.mjs';
import { installPageQa, beginPageQaFrame, endPageQaFrame, finishPageQaChunk, mergePageQaChunks } from '../../engine/render/lib/page-qa.mjs';
import { captureGpuFrame } from '../../engine/render/lib/yuv.mjs';
import { runTexts, measureContrast } from '../../tools/qa/checks/texts.mjs';
import { decodePng } from '../../tools/qa/lib/png.mjs';
import { loadProfiles, resolveProfile } from '../../tools/qa/lib/profiles.mjs';

const width = 320, height = 180, fps = 24, frameCount = 12;
const profile = resolveProfile(loadProfiles(), 'web-1080p24');
for (const randomAccess of [false, true]) for (const samples of [1, 2]) {
  test(`V11 文字对比度：${randomAccess ? '可跳帧长渐入' : '依赖历史的亚 1 峰值'}、跨块首次同峰、${samples} 次曝光`, { skip: !browserOk }, async t => {
    const alphas = randomAccess ? [.1, .2, .4, .6, .8, .8, .1, .2, .4, .6, .8, samples === 2 ? 1 : .8] : [.1, .3, .3, .2, .3, .1, .2, .8, .8, .4, .6, .8];
    const winner = alphas.indexOf(Math.max(...alphas));
    const html = `<!doctype html><style>*{margin:0}body{background:#123}canvas{display:block}</style><canvas width=320 height=180></canvas><script>
      const c=document.querySelector('canvas').getContext('2d');let calls=0,f=-1;const alphas=${JSON.stringify(alphas)};
      window.render=t=>{calls++;f=Math.floor(t*24+1e-5);c.globalAlpha=1;c.fillStyle='rgb('+ (${randomAccess ? 'f' : 'calls'}*3) +',20,20)';c.fillRect(0,0,320,180);c.font='bold 24px sans-serif';c.fillStyle='white';c.globalAlpha=alphas[f];c.fillText('TEST',22,54);};
      window.TEXTS=()=>[{id:'t',text:'TEST',box:[20,30,72,28],alpha:alphas[f]}];window.count=()=>calls;</script>`;
    const browser = await launchBrowser({ angle: 'swiftshader', handleSignals: false });
    t.after(() => browser.close());
    const shots = [];
    async function film(qa) {
      const page = await browser.newPage({ viewport: { width, height } });
      if (qa) await installPageQa(page, 'http://page.invalid');
      await page.goto('data:text/html,' + encodeURIComponent(html));
      // 旁听真实 CDP 截图，单独统计 QA 取样，不把成片或对照组算进去。
      const context = page.context(), connect = context.newCDPSession.bind(context);
      context.newCDPSession = async p => {
        const cdp = await connect(p), send = cdp.send.bind(cdp);
        cdp.send = (name, args) => { if (qa && name === 'Page.captureScreenshot') shots.push(args.clip || 'full'); return send(name, args); };
        return cdp;
      };
      const capture = () => { if (qa) shots.push('full'); return page.screenshot({ type: 'png' }); };
      return { page, capture, check() {}, external: [], contract: { texts: true, dur: frameCount / fps } };
    }
    const master = await film(true), control = await film(false), aux = await film(true);
    const revisited = [], parts = [], start = performance.now();
    let cursor = 0;
    const revisit = async (target, take) => {
      revisited.push(target);
      for (let f = randomAccess ? target : cursor; f <= target; f++) {
        await aux.page.evaluate(t => window.render(t), f / fps);
        if (f === target) await take(aux);
        if (!randomAccess && samples === 2) await aux.page.evaluate(t => window.render(t), (f + .25) / fps);
      }
      cursor = target + 1;
    };
    let oracle;
    for (let a = 0; a < frameCount; a += 6) {
      const rows = [], peaks = new Map();
      for (let f = a; f < a + 6; f++) {
        const opts = { w: width, h: height, format: 'png', samples, fps, dur: frameCount / fps };
        await beginPageQaFrame(master);
        const record = async () => rows.push(await endPageQaFrame(master, { frame: f, fps, peaks }));
        const actual = await captureGpuFrame(master, f / fps, { ...opts, afterFirstSample: record });
        if (samples === 1) await record();
        // 全尺寸独立对照：真实前景配已知纯色背景，核对裁片的亮度、背景/笔画像素数和 WCAG 比值。
        const reference = async () => {
          const on = decodePng(await control.capture()), off = { ...on, data: new Uint8Array(on.data.length) };
          const red = 3 * (randomAccess ? f : f * samples + 1);
          for (let i = 0; i < off.data.length; i += 4) off.data.set([red, 20, 20, 255], i);
          oracle = measureContrast(on, off, [20, 30, 92, 58]);
        };
        const expected = await captureGpuFrame(control, f / fps, { ...opts, afterFirstSample: f === winner && reference });
        if (samples === 1 && f === winner) await reference();
        assert.ok(actual.equals(expected), `探针改变了成片第 ${f} 帧`);
      }
      parts.push(await finishPageQaChunk(master, rows, peaks, revisit));
    }
    t.diagnostic(`12 帧；QA 截图 ${shots.length} 张，全画幅 ${shots.filter(s => s === 'full').length} 张，重访 ${revisited.length} 帧；含对照与 QA 耗时 ${Math.round(performance.now()-start)} ms`);
    const localPeaks = [0, 6].map(a => alphas.indexOf(Math.max(...alphas.slice(a, a+6)), a));
    assert.deepEqual(parts.map(p => p.rows.filter(r => r.contrast.length).map(r => r.f)), localPeaks.map(f => [f]));
    assert.equal(await master.page.evaluate(() => window.count()), frameCount*samples);
    assert.deepEqual(revisited, localPeaks.filter(f => alphas[f] < 1));
    assert.equal(shots.length, 4, '累积页与可跳帧页一样，只能截两个分片峰值的前景和背景');
    assert.ok(shots.every(s => s.width === 88 && s.height === 44));
    const { texts } = mergePageQaChunks(parts.reverse(), { width, height, fps, frameCount });
    assert.deepEqual(texts.frames.filter(r => r.contrast.length).map(r => r.f), [winner]);
    for (const step of [1, 2, 3]) {
      const result = await runTexts({ profile, size: [width,height], recorded: texts, step });
      const row = result.checks.find(c => c.id === 'texts.contrast').evidence.rows[0];
      assert.equal(row.frame, winner); assert.equal(row.alpha, alphas[winner]);
      assert.ok(oracle.separable); for (const [key, value] of Object.entries(oracle)) assert.equal(row[key], value, key);
    }
  });
}

for (const samples of [1, 2]) test(`V11 实际 worker：跳过缓存分片，按时序取两条累积文字的峰值，${samples} 次曝光`,
  { skip: !browserOk || !haveFfmpeg }, async t => {
    const fixture = miniRepo(null);
    t.after(fixture.cleanup);
    const { renderRange } = await import(pathToFileURL(fixture.script('lib/chunks.mjs')));
    const { openFilm, closeServer } = await import(pathToFileURL(fixture.script('page.mjs')));
    t.after(closeServer);
    fs.mkdirSync(fixture.film, { recursive: true });
    fs.writeFileSync(join(fixture.film, 'index.html'), `<!doctype html><style>*{margin:0}canvas{display:block}</style><canvas width=320 height=180></canvas><script>
      window.DUR=18/24;window.times=[];window.reads=[];
      const ctx=document.querySelector('canvas').getContext('2d');let state=7, f=0;
      const late=[.1,.2,.3,.5,.8,.8],early=[.1,.7,.7,.4,.3,.2];
      window.render=t=>{times.push(t);f=Math.floor(t*24+1e-5);state=(state*7+1+Math.round(t*240))%180;
        ctx.globalAlpha=1;ctx.fillStyle='rgb('+state+',20,20)';ctx.fillRect(0,0,320,180);ctx.font='bold 24px sans-serif';ctx.fillStyle='white';
        ctx.globalAlpha=late[f%6];ctx.fillText('LATE',22,54);ctx.globalAlpha=early[f%6];ctx.fillText('EARLY',132,54);};
      window.TEXTS=()=>{reads.push(f);return [{id:'late',text:'LATE',box:[20,30,80,28],alpha:late[f%6]},
        {id:'early',text:'EARLY',box:[130,30,80,28],alpha:early[f%6]}];};window.render(0);window.READY=true;</script>`);
    const workDir = join(fixture.base, 'qa'), plainDir = join(fixture.base, 'plain');
    for (const d of [workDir, plainDir]) fs.mkdirSync(d);
    const chunks = [[0,6],[6,12],[12,18]], active = [chunks[0], chunks[2]];
    const openOptions = { w: width, h: height, gpu: 'software-ok', angle: 'swiftshader', render: { fps } };
    const opts = { dir: fixture.film, w: width, h: height, fps, chunks, workers: 1, samples, shutter: .8, intermediate: 'png',
      outputs: [{ kind: 'master', vf: 'format=yuv420p', args: ['-c:v','libx264','-preset','ultrafast'] }],
      workDir, openOptions, signal: new AbortController().signal, live: new Set(), key: 'contrast' };
    const qaOpts = { ...opts, openOptions: { ...openOptions, pageQa: true }, qaSpec: { width, height, fps, frames: 18 }, keepQaParts: true };
    // 预先渲好中间块。正式续跑时同一个工作页只经历 0–5 与 12–17。
    await renderRange({ ...qaOpts, chunks: [chunks[1]], qaSpec: { ...qaOpts.qaSpec, frames: 6 } });
    const control = await openFilm(fixture.film, openOptions);
    t.after(control.close);
    const oracles = new Map();
    await control.page.exposeFunction('saveReference', (f, png) => {
      const on = decodePng(Buffer.from(png.split(',')[1], 'base64'));
      const off = { ...on, data: Buffer.alloc(on.data.length, on.data.subarray(0, 4)) };
      const x = f % 6 === 1 ? 130 : 20;
      oracles.set(f, measureContrast(on, off, [x,30,x+80,58]));
    });
    await control.page.evaluate(() => {
      const render = window.render;
      window.render = async t => {
        render(t);
        const f = Math.round(t * 24);
        if (Math.abs(t * 24 - f) < 1e-6 && [1,4].includes(f % 6)) await window.saveReference(f, document.querySelector('canvas').toDataURL());
      };
    });
    const plain = await renderRange({ ...opts, chunks: active, workDir: plainDir, firstFilm: control });
    const shots = [], ctx = Object.getPrototypeOf(control.page.context()), connect = ctx.newCDPSession;
    t.mock.method(ctx, 'newCDPSession', async function (page) {
      const cdp = await connect.call(this, page), send = cdp.send.bind(cdp);
      cdp.send = async (name, args) => {
        if (name === 'Page.captureScreenshot') shots.push({ clip: args.clip, ...await page.evaluate(() => ({ times, reads })) });
        return send(name, args);
      };
      return cdp;
    });
    const start = performance.now(), actual = await renderRange({ ...qaOpts, reuse: true });
    const ms = Math.round(performance.now() - start), crops = shots.filter(s => s.clip);
    assert.equal(actual.stats.reusedChunks, 1);
    assert.equal(actual.stats.renderedFrames, 12);
    assert.equal(shots.length - crops.length, samples === 1 ? 12 : 0, '全幅截图数与正常母版需要的次数相同');
    const expectedFrames = [...plain.hashMap.keys()];
    assert.deepEqual(expectedFrames, [0,1,2,3,4,5,12,13,14,15,16,17]);
    assert.equal(crops.length, 8, '两块 × 两条文字 × 前景与背景');
    const targets = [1,4,13,16];
    for (const [i, crop] of crops.entries()) {
      const f = targets[Math.floor(i / 2)], reads = expectedFrames.filter(k => k <= f);
      const times = [0];  // 页面 READY 之前的预热
      for (const k of reads) {
        times.push(k / fps);
        if (samples === 2 && k !== f) times.push(k / fps + .4 / fps);
      }
      assert.deepEqual(crop.times, times, '取证保留本路的预热、非连续分片、快门和首子帧');
      assert.deepEqual(crop.reads, reads);
      assert.deepEqual([crop.clip.width, crop.clip.height], [96,44]);
    }
    for (const [j, [a,b]] of active.entries()) {
      const mp4 = actual.files.master[j * 2];
      assert.deepEqual(framemd5(mp4), framemd5(plain.files.master[j]), '编码母版逐帧一致');
      const { pageQa } = JSON.parse(fs.readFileSync(mp4 + '.json', 'utf8'));
      for (const row of pageQa.rows) {
        assert.equal(actual.hashMap.get(row.f).slice(0,16), plain.hashMap.get(row.f), '编码前像素一致');
        if (![a+1,b-2].includes(row.f)) { assert.deepEqual(row.contrast, []); continue; }
        assert.equal(row.contrast.length, 1);
        const [m] = row.contrast, oracle = oracles.get(row.f);
        assert.equal(m.id, row.f === a+1 ? 'early' : 'late');
        assert.ok(oracle.separable);
        for (const [key, value] of Object.entries(oracle)) assert.equal(m[key], value, `第 ${row.f} 帧 ${key}`);
      }
    }
    assert.deepEqual(actual.qaRecords.texts.frames.filter(r => r.contrast.length).map(r => r.f), [1,4]);
    t.diagnostic(`实际 worker 渲 12 帧、复用 6 帧，取证 ${targets.join('/')} 帧各 2 张 96×44 裁片；续跑含编码和 QA ${ms} ms`);
  });