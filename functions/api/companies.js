const PRODUCTION_URL = 'https://goodcorp.games/data/v1/index.json';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' };

export async function onRequestGet() {
  try {
    const response = await fetch(PRODUCTION_URL, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const companies = Array.isArray(data.companies)
      ? data.companies.map(company => ({
        id: company.id,
        name: company.name,
        slug: company.slug,
      }))
      : [];
    return new Response(JSON.stringify({ companies }), { headers: JSON_HEADERS });
  } catch {
    return new Response(JSON.stringify({ companies: [] }), {
      headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}
