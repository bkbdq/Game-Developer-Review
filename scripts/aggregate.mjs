import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'data');
const testDir = resolve(root, 'data-test');
const includeTest = process.argv.includes('--test');
const outDir = resolve(root, 'site/public/data/v1');
const generatedDir = resolve(root, 'site/src/generated');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const dataDirs = includeTest ? [dataDir, testDir] : [dataDir];
const round = value => Math.round(value * 10) / 10;
const avg = scores => scores.length ? round(scores.reduce((sum, n) => sum + n, 0) / scores.length) : null;
const median = scores => {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);
};

function shanghaiNow() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

function loadCompanies() {
  const companies = new Map();
  for (const dir of dataDirs) {
    const companyDir = join(dir, 'companies');
    if (!existsSync(companyDir)) continue;
    readdirSync(companyDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(companyDir, name)))
      .forEach(company => {
        if (!companies.has(company.id)) companies.set(company.id, company);
      });
  }
  return [...companies.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function loadReviews(companyId) {
  const reviews = new Map();
  for (const dir of dataDirs) {
    const reviewDir = join(dir, 'reviews', companyId);
    if (!existsSync(reviewDir)) continue;
    readdirSync(reviewDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(reviewDir, name)))
      .forEach(review => {
        if (!reviews.has(review.id)) reviews.set(review.id, review);
      });
  }
  return [...reviews.values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}

function distribution(reviews) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  reviews.forEach(review => { counts[review.score] += 1; });
  return counts;
}

function topTags(reviews) {
  const counts = new Map();
  reviews.forEach(review => (review.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function byProfile(reviews) {
  const dims = ['tenure', 'employment', 'city'];
  return Object.fromEntries(dims.map(dim => {
    const groups = new Map();
    reviews.forEach(review => {
      const key = review.profile && review.profile[dim];
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(review.score);
    });
    return [dim, [...groups.entries()]
      .filter(([, scores]) => scores.length >= 3)
      .map(([key, scores]) => ({ key, count: scores.length, avgScore: avg(scores) }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))];
  }));
}

function buildDetail(company) {
  const allProjects = Array.isArray(company.projects) ? company.projects : [];
  const projects = allProjects.filter(project => !project.hidden);
  const hiddenProjectIds = new Set(allProjects.filter(project => project.hidden).map(project => project.id));
  const reviews = loadReviews(company.id)
    .filter(review => !review.hidden && !(review.projectId && hiddenProjectIds.has(review.projectId)));
  const scores = reviews.map(review => review.score);
  const perProject = new Map(projects.map(project => [project.id, []]));
  reviews.forEach(review => {
    if (review.projectId && perProject.has(review.projectId)) perProject.get(review.projectId).push(review.score);
  });
  return {
    schemaVersion: 1,
    company: {
      id: company.id,
      slug: company.slug,
      name: company.name,
      reviewCount: reviews.length,
      avgScore: avg(scores),
      scoreDistribution: distribution(reviews),
    },
    projects: projects.map(project => {
      const projectScores = perProject.get(project.id);
      return {
        id: project.id,
        name: project.name,
        status: project.status,
        ...(Array.isArray(project.aliases) && project.aliases.length ? { aliases: project.aliases } : {}),
        ...(project.featuredReviewId && { featuredReviewId: project.featuredReviewId }),
        reviewCount: projectScores.length,
        avgScore: avg(projectScores),
      };
    }),
    byProfile: byProfile(reviews),
    reviews,
  };
}

function main() {
  const taxonomy = readJson(join(dataDir, 'taxonomy.json'));
  const companies = loadCompanies().filter(company => !company.hidden);
  const generatedAt = shanghaiNow();
  const details = companies.map(company => ({ company, detail: buildDetail(company) }));
  const reviewTotal = details.reduce((sum, item) => sum + item.detail.company.reviewCount, 0);
  const projectTotal = companies.reduce(
    (sum, company) => sum + (company.projects || []).filter(project => !project.hidden).length,
    0,
  );

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'companies'), { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  // 别名仅用于构建期搜索匹配，不进入公开 JSON / API
  const aliases = Object.fromEntries(companies.map(company => [company.id, company.aliases || []]));
  writeFileSync(join(generatedDir, 'aliases.json'), JSON.stringify(aliases, null, 2) + '\n', 'utf8');

  const index = {
    schemaVersion: 1,
    generatedAt,
    totals: { companies: companies.length, projects: projectTotal, reviews: reviewTotal },
    companies: details.map(({ detail }) => ({
      ...detail.company,
      projectCount: detail.projects.length,
      medianScore: median(detail.reviews.map(review => review.score)),
      lastPublishedAt: detail.reviews.reduce((latest, review) => review.publishedAt > latest ? review.publishedAt : latest, ''),
      topTags: topTags(detail.reviews),
    })),
  };
  index.companies.forEach(company => { company.lastPublishedAt ||= null; });

  const manifest = { schemaVersion: 1, generatedAt, totals: index.totals };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'taxonomy.json'), JSON.stringify(taxonomy, null, 2) + '\n', 'utf8');
  details.forEach(({ company, detail }) => {
    writeFileSync(join(outDir, 'companies', company.id + '.json'), JSON.stringify(detail, null, 2) + '\n', 'utf8');
  });

  console.log(`聚合完成：${companies.length} 家公司，${projectTotal} 个项目，${reviewTotal} 条评价 → ${outDir}`);
}

main();
