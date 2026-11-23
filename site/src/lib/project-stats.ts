export interface RatedEntry { score: number; publishedAt: string }
const day = 86_400_000;

export const minimumPositiveRatio = .7;
export const minimumPickScore = 4;
export const minimumRatingCount = 5;

const gradeScale = ['特别差评', '差评', '多半差评', '褒贬不一', '多半好评', '好评', '特别好评', '好评如潮'] as const;

function gradeFor(ratio: number | null, count: number): typeof gradeScale[number] {
  if (ratio === null) return '褒贬不一';
  if (ratio >= .95 && count >= 50) return '好评如潮';
  if (ratio >= .8) return count >= 20 ? '特别好评' : '好评';
  if (ratio >= minimumPositiveRatio) return '多半好评';
  if (ratio >= .4) return '褒贬不一';
  if (ratio >= .2) return '多半差评';
  return count >= 20 ? '特别差评' : '差评';
}

export function reviewRating(positive: number, count: number, neutral: number) {
  const negative = count - positive - neutral;
  const rated = count >= minimumRatingCount;
  const ratio = rated && positive + negative > 0 ? positive / (positive + negative) : null;
  const grade = gradeFor(ratio, count);
  const gradeRank = rated ? gradeScale.indexOf(grade) : -1;
  const tone = !rated ? 'insufficient' : grade === '褒贬不一' ? 'neutral' : positive > negative ? 'positive' : 'negative';
  const label = rated ? grade : count ? '评分过少' : '暂无评价';
  return { count, positive, neutral, negative, ratio, grade: label, gradeRank, rated, tone };
}

export type Rating = ReturnType<typeof reviewRating>;

export function isRecentPick(project: { positive: number; negative: number; meanScore: number | null; recentPositive: number }) {
  return project.meanScore !== null && project.meanScore >= minimumPickScore &&
    project.recentPositive > 0 && project.positive >= (project.positive + project.negative) * minimumPositiveRatio;
}

export function projectStats(reviews: RatedEntry[], asOf: string) {
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = end - 29 * day;
  let positive = 0, neutral = 0, recentPositive = 0, latest = '', scoreSum = 0;
  for (const review of reviews) {
    scoreSum += review.score;
    if (review.publishedAt > latest) latest = review.publishedAt;
    if (review.score === 3) neutral++;
    if (review.score < 4) continue;
    positive++;
    const date = Date.parse(review.publishedAt.slice(0,10) + 'T00:00:00Z');
    if (date >= start && date <= end) recentPositive++;
  }
  const meanScore = reviews.length ? scoreSum / reviews.length : null;
  return { ...reviewRating(positive, reviews.length, neutral), recentPositive, latest, meanScore };
}

type Ranked = ReturnType<typeof projectStats> & { name: string; path: string };
export function compareProjects(a: Ranked, b: Ranked) {
  return b.recentPositive-a.recentPositive || b.positive-a.positive || b.count-a.count ||
    b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name,'zh-CN') || a.path.localeCompare(b.path);
}
