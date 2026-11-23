/**
 * 相似内容检测（M4·FE-3）。
 * 用归一化后的字符二元组 TF 余弦相似度，对中文评价文本无需分词。
 * 纯函数，可在 Node 中单测。
 */
import { normalize } from './match.js';

function bigramCounts(text) {
  const source = normalize(text);
  const counts = new Map();
  for (let i = 0; i < source.length - 1; i += 1) {
    const gram = source.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

/** 0–1 的相似度；任一边为空返回 0。完全一致 = 1。 */
export function similarity(a, b) {
  const left = bigramCounts(a);
  const right = bigramCounts(b);
  if (!left.size || !right.size) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const count of left.values()) normA += count * count;
  for (const [gram, count] of right) {
    normB += count * count;
    const other = left.get(gram);
    if (other) dot += other * count;
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * 在候选里找相似评价。candidates: [{ id, text, ...标记 }]，
 * 返回按相似度降序的 [{ item, score }]，score ≥ threshold。
 */
export function findSimilar(text, candidates, { threshold = 0.75, limit = 5 } = {}) {
  const source = String(text || '');
  if (!source.trim()) return [];
  return (candidates || [])
    .map(item => ({ item, score: similarity(source, item.text) }))
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
