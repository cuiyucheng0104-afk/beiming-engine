(() => { const res = []; const L0 = Math.log;
  const lk = S3.K.findIndex(k => Math.abs(k[0] - 12) < 1e-6), pk = S3.K.findIndex(k => Math.abs(k[0] - 16) < 1e-6);
  const base = [S3.K[lk][1].slice(), S3.K[pk][1].slice()];
  for (const sc of [1.06, 1.1]) for (const vis of [.21]) for (const lean of [1.1, 1.15]) {
    const a = base[0].slice(), b = base[1].slice(); a[6] = L0(vis); b[6] = L0(vis * .94); S3.setKey(lk, a); S3.setKey(pk, b); S3.tune(.134, lean, sc);
    let mn = 1e9, at = 0, bot = 0, ht = 1e9;
    for (let f = 362; f <= 528; f++) { const t = f / 30; S3.update(t); const G = S3.geo(); const L = G.label; if (!L || G.labelP < .95 || L[1] > 1080) continue;
      if (t < 16.4) { bot = Math.max(bot, L[3]); ht = Math.min(ht, L[3] - L[1]); }
      G.cards.forEach(c => { if (c && Math.min(c[2], L[2]) > Math.max(c[0], L[0])) { const g = L[1] - c[3]; if (g < mn) { mn = g; at = t; } } }); }
    res.push(`sc ${sc} vis ${vis} lean ${lean}: gap ${mn.toFixed(1)}@${at.toFixed(2)} labelBottom ${bot.toFixed(0)} minLabelH ${ht.toFixed(0)}`);
  }
  return res.join('\n'); })()
