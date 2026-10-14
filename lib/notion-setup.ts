import {checkSchema, NOTION_SCHEMA, NOTION_VERSION, notionId, resolveDataSourceId} from './notion';
import {providerFetch, type FetchOptions} from './provider-fetch';

const API = 'https://api.notion.com/v1';

const headers = (token: string) => ({Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json'});

async function call(url: string, init: RequestInit, opts: FetchOptions) {
  const res = await providerFetch('notion.setup', url, init, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion returned ${res.status}${body?.code ? ` (${body.code})` : ''}.`);
  return body;
}

const blockedByRelation = (dataSourceId: string) => ({
  'Blocked By': {relation: {data_source_id: dataSourceId, type: 'single_property', single_property: {}}}
});

export async function createTasksDatabase(token: string, parentPageId: string, opts: FetchOptions = {}) {
  const db = await call(`${API}/databases`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      parent: {type: 'page_id', page_id: notionId(parentPageId)},
      title: [{type: 'text', text: {content: 'Deevaa Tasks'}}],
      initial_data_source: {properties: NOTION_SCHEMA}
    })
  }, opts);
  const dataSourceId: string | undefined = db?.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error('Notion created the database but returned no data source id.');
  let relationAdded = true;
  try {
    await call(`${API}/data_sources/${dataSourceId}`, {method: 'PATCH', headers: headers(token), body: JSON.stringify({properties: blockedByRelation(dataSourceId)})}, opts);
  } catch {
    relationAdded = false;
  }
  return {databaseId: db.id as string, dataSourceId, relationAdded};
}

/** Reports missing properties and, when `apply` is true, adds them without touching existing ones. */
export async function checkTasksDataSource(
  token: string,
  ids: {dataSourceId?: string; databaseId?: string},
  apply: boolean,
  opts: FetchOptions = {}
) {
  const dataSourceId = await resolveDataSourceId({token, dataSourceId: notionId(ids.dataSourceId), databaseId: notionId(ids.databaseId)}, opts);
  const ds = await call(`${API}/data_sources/${dataSourceId}`, {headers: headers(token)}, opts);
  const schema = checkSchema(ds.properties ?? {});
  const missing = [...schema.missing, ...(ds.properties?.['Blocked By'] ? [] : ['Blocked By'])];
  if (apply && missing.length) {
    const add: Record<string, unknown> = {};
    for (const name of missing) {
      if (name === 'Blocked By') Object.assign(add, blockedByRelation(dataSourceId));
      else add[name] = NOTION_SCHEMA[name as keyof typeof NOTION_SCHEMA];
    }
    await call(`${API}/data_sources/${dataSourceId}`, {method: 'PATCH', headers: headers(token), body: JSON.stringify({properties: add})}, opts);
  }
  return {dataSourceId, titleProperty: schema.title, statusProperty: schema.status, missing, applied: apply && missing.length > 0};
}
