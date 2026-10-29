export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Greedy single pass: join the most similar cluster centroid if above threshold, else start a new one. */
export function cluster(vectors: number[][], threshold: number): number[][] {
  const clusters: { members: number[]; centroid: number[] }[] = [];
  vectors.forEach((v, i) => {
    let best = -1, bestSim = threshold;
    clusters.forEach((c, ci) => { const s = cosine(v, c.centroid); if (s >= bestSim) { best = ci; bestSim = s; } });
    if (best < 0) { clusters.push({ members: [i], centroid: [...v] }); return; }
    const c = clusters[best];
    c.centroid = c.centroid.map((x, d) => (x * c.members.length + v[d]) / (c.members.length + 1));
    c.members.push(i);
  });
  return clusters.map((c) => c.members);
}
