import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewFile, TaxonomyFile } from './schema-types';
import aliasesByCompany from '../generated/aliases.json';

export type Entry = TaxonomyFile['roles'][number];
export type ProfileKey = 'role' | 'tenure' | 'employment' | 'city';
export type Taxonomy = TaxonomyFile;
export interface Company {
  id: string; slug: string; name: string;
  reviewCount: number; avgScore: number | null; scoreDistribution: Record<string, number>;
}
export interface Summary extends Company {
  projectCount: number; medianScore: number | null; lastPublishedAt: string | null;
  topTags: { key: string; count: number }[];
}
export type Review = Pick<ReviewFile,
  'id' | 'projectId' | 'score' | 'title' | 'comment' | 'profile' | 'tags' | 'publishedAt' | 'revision'
>;
export interface Detail {
  company: Company;
  projects: { id: string; name: string; status: string; aliases?: string[]; featuredReviewId?: string; reviewCount: number; avgScore: number | null }[];
  byProfile: Partial<Record<ProfileKey, { key: string; count: number; avgScore: number }[]>>;
  reviews: Review[];
}
interface Index {
  generatedAt: string; totals: { companies: number; projects: number; reviews: number }; companies: Summary[];
}

export const isDemo = import.meta.env.GOODCORP_DEV_SERVER && process.env.SITE_DEMO === '1';
const directory = process.env.REVIEW_DATA_DIR || resolve('public/data/v1');
function read<T>(name: string): T {
  const value = JSON.parse(readFileSync(resolve(directory, name + '.json'), 'utf8'));
  if (value.schemaVersion !== 1) throw new Error('不支持的数据版本：' + name);
  return value;
}
export const index = read<Index>('index');
export const taxonomy = read<Taxonomy>('taxonomy');
export const manifest = read('manifest');
export function detail(id: string) {
  if (!/^c_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的公司 ID：' + id);
  return read<Detail>('companies/' + id);
}
export const href = (path = '') => import.meta.env.BASE_URL.replace(/\/?$/, '/') + path;
export const companyAliases = (id: string) => (aliasesByCompany as Record<string, string[]>)[id] ?? [];
export const scoreText = (score: number | null) => score == null ? '—' : score.toFixed(1);
export const label = (items: Entry[], key?: string) => items.find(item => item.key === key)?.label ?? key;
export const month = (date?: string | null) => date ? date.slice(0, 7).replace('-', '.') : '—';
