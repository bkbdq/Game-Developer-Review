import { companyAliases, detail, href, index } from './data';
import { compareProjects, isRecentPick, projectStats } from './project-stats';

const artwork: Record<string, [string, string]> = {
  p_kite: ['THE KITE MENDER','kite'], p_windward: ['WINDWARD ISLES','windward'],
  p_thread: ['DREAM POST','thread'], p_bell: ['SEVENTH CHIME','bell'],
  p_tidelight: ['TIDELIGHT','tidelight'], p_lantern: ['LETTERS FROM THE LIGHT','lantern'],
  p_fog: ['MISTBOUND EXPRESS','fog'], p_lastferry: ['THE LAST FERRY','lastferry'],
  p_mossyard: ['MOSS & GEAR','mossyard'], p_emberpath: ['EMBER PATH','emberpath'],
  p_sand: ['DUNE SAILS','sand'], p_snowpost: ['SNOWLINE POST','snowpost'],
};
export const asOf = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(index.generatedAt));
export const statuses: Record<string,string> = {live:'已上线',dev:'在研',cancelled:'已取消',unknown:'状态未知'};
const studios = index.companies.map(company => {
  const data = detail(company.id);
  return {company, data, rating: projectStats(data.reviews, asOf)};
});
export const companyRatings = new Map(studios.map(studio => [studio.company.id, studio.rating]));
export const projects = studios.flatMap(({company:c, data, rating}) => {
  const aliases = companyAliases(c.id);
  return data.projects.map(project => {
    const reviews = data.reviews.filter(r=>r.projectId===project.id).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
    const featuredReview = reviews.find(r=>r.id===project.featuredReviewId)
      ?? reviews.find(r=>r.score>=4) ?? reviews[0];
    const art = artwork[project.id];
    const thumb = art && href(`images/projects/${art[1]}-1.webp`);
    const cover = art && href('images/projects/' + (project.id === 'p_kite' ? 'kite-cover' : art[1] + '-1') + '.webp');
    const scene = art && href(`images/projects/${art[1]}-2.webp`);
    return {
      id: project.id, name: project.name, statusKey: project.status, status: statuses[project.status] || statuses.unknown,
      company: c.name, companyRating:rating, slug:c.slug, aliases, reviews, featuredReview, cover, thumb, scene,
      path:href(`project/${encodeURIComponent(c.slug)}/${encodeURIComponent(project.id)}/`),
      search:[c.name,c.slug,...aliases,project.name,art?.[0]].join(' ').normalize('NFKC').toLocaleLowerCase(),
      ...projectStats(reviews,asOf)
    };
  });
}).sort(compareProjects);
export type Project = (typeof projects)[number];
export const recentPicks = projects.filter(isRecentPick);
export const projectsByStudio = Map.groupBy(projects, project => project.slug);
