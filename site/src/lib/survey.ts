/** Keep all entry points on the same questionnaire and pass editable display names. */
export function surveyUrl(company?: string, project?: string) {
  const url = new URL(import.meta.env.PUBLIC_SURVEY_URL || 'https://gdr-survey.pages.dev/');
  if (company) url.searchParams.set('company', company);
  if (project) url.searchParams.set('project', project);
  return url.toString();
}
