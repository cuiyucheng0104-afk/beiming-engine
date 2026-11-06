(() => { const res = [];
  for (const z of [.124, .13, .134]) for (const lean of [.5, .7, .9, 1.05]) {
    S3.tune(z, lean); let mn = 1e9, bot = 0;
    for (let f = 362; f <= 510; f += 2) { const t = f / 30; S3.update(t); const G = S3.geo(); const L = G.label; if (!L || G.labelP < .95) continue;
      if (t < 16.6) bot = Math.max(bot, L[3]);
      G.cards.forEach((c, i) => { if (c && Math.min(c[2], L[2]) > Math.max(c[0], L[0])) mn = Math.min(mn, L[1] - c[3]); }); }
    res.push([z, lean, mn.toFixed(1), bot.toFixed(0)].join(' '));
  }
  return res.join('\n'); })()
