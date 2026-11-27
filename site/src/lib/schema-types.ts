// 由 scripts/gen-types.mjs 根据 schema/*.schema.json 自动生成，请勿手改。

export type ReviewFile = {
  schemaVersion: 1;
  id: string;
  companyId: string;
  projectId?: string;
  projectAnonymous?: true;
  score: number;
  title?: string;
  comment: string;
  profile?: {
    role?: string;
    tenure?: string;
    employment?: string;
    city?: string;
  };
  tags?: string[];
  publishedAt: string;
  revision: number;
  hidden?: boolean;
};

export type CompanyFile = {
  schemaVersion: 1;
  id: string;
  slug: string;
  name: string;
  aliases?: string[];
  hidden?: boolean;
  projects: ({
    id: string;
    name: string;
    status: "live" | "dev" | "cancelled" | "unknown";
    aliases?: string[];
    hidden?: boolean;
    genre?: string;
    featuredReviewId?: string;
  })[];
  createdAt: string;
  updatedAt: string;
};

export type TaxonomyFile = {
  schemaVersion: 1;
  roles: {
    key: string;
    label: string;
  }[];
  tenures: {
    key: string;
    label: string;
  }[];
  employments: {
    key: string;
    label: string;
  }[];
  cities: {
    key: string;
    label: string;
  }[];
  tags: {
    key: string;
    label: string;
  }[];
};
