import { companyAliases, detail, href, index } from './data';
import { catalogArtwork, defaultArtwork } from './artwork';
import { compareProjects, isRecentPick, projectStats } from './project-stats';

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
    const configured = catalogArtwork(c.id, project.id);
    const thumb = configured?.card ?? defaultArtwork;
    const cover = configured?.cover ?? defaultArtwork;
    const scene = thumb;
    return {
      id: project.id, name: project.name, statusKey: project.status, status: statuses[project.status] || statuses.unknown,
      company: c.name, companyRating:rating, slug:c.slug, aliases, reviews, featuredReview, cover, thumb, scene,
      hasArtwork: Boolean(configured), detailArt: configured?.detail ?? defaultArtwork, cardArt: thumb,
      path:href(`project/${encodeURIComponent(c.slug)}/${encodeURIComponent(project.id)}/`),
      search:[c.name,c.slug,...aliases,project.name,...(project.aliases ?? [])].join(' ').normalize('NFKC').toLocaleLowerCase(),
      ...projectStats(reviews,asOf)
    };
  });
}).sort(compareProjects);
export type Project = (typeof projects)[number];
export const recentPicks = projects.filter(isRecentPick);
export const projectsByStudio = Map.groupBy(projects, project => project.slug);
