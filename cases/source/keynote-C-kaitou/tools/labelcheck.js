(() => { const out = []; let mn = 1e9, worst = 0;
  for (let f = 360; f <= 525; f++) { const t = f / 30; S3.update(t); const G = S3.geo(); const L = G.label;
    if (!L || G.labelP < .95) continue;
    const bot = L[3]; if (bot > worst) worst = bot;
    G.cards.forEach((c, i) => { if (c && Math.min(c[2], L[2]) > Math.max(c[0], L[0])) mn = Math.min(mn, L[1] - c[3]); });
    if (f % 15 === 0) out.push(t.toFixed(1) + ' label ' + L.map(Math.round).join(',') + ' cards ' + G.cards.map(c => c ? Math.round(c[3]) : '-').join('/'));
  }
  return out.join('\n') + '\nmin gap ' + mn.toFixed(1) + ' max label bottom ' + worst.toFixed(0); })()
