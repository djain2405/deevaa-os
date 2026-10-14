import {loadEnvConfig} from '@next/env';
import {checkTasksDataSource, createTasksDatabase} from '../lib/notion-setup';

loadEnvConfig(process.cwd());

const usage = `Usage:
  npm run notion:setup              Create "Deevaa Tasks" under NOTION_PARENT_PAGE_ID
  npm run notion:setup -- --check   Validate the configured data source schema
  npm run notion:setup -- --fix     Add any missing optional properties to the configured data source`;

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN is not set in .env.local.');
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) return console.log(usage);

  const existing = {dataSourceId: process.env.NOTION_DATA_SOURCE_ID || undefined, databaseId: process.env.NOTION_DATABASE_ID || undefined};
  if (args.has('--check') || args.has('--fix')) {
    if (!existing.dataSourceId && !existing.databaseId) throw new Error('Set NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID first.');
    const r = await checkTasksDataSource(token, existing, args.has('--fix'));
    console.log(`Data source: ${r.dataSourceId}`);
    console.log(`Title property: ${r.titleProperty ?? 'MISSING'}; Status property: ${r.statusProperty ?? 'MISSING (required)'}`);
    console.log(r.missing.length ? `${r.applied ? 'Added' : 'Missing'} properties: ${r.missing.join(', ')}` : 'All Deevaa properties are present.');
    return;
  }

  const parent = process.env.NOTION_PARENT_PAGE_ID;
  if (!parent) throw new Error('Set NOTION_PARENT_PAGE_ID to the page that should contain the database, and share that page with the integration.');
  if (existing.dataSourceId) throw new Error('NOTION_DATA_SOURCE_ID is already set. Use --check or --fix instead of creating a second database.');
  const r = await createTasksDatabase(token, parent);
  console.log('Created "Deevaa Tasks". Add these to .env.local:');
  console.log(`NOTION_DATABASE_ID=${r.databaseId}`);
  console.log(`NOTION_DATA_SOURCE_ID=${r.dataSourceId}`);
  if (!r.relationAdded) console.log('Note: the optional "Blocked By" relation could not be added; run with --fix later.');
}

main().catch((e) => {
  console.error(`Notion setup failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});
