import {loadEnvConfig} from '@next/env';
import {validateEnv} from '../lib/env';

loadEnvConfig(process.cwd());

const production = process.argv.includes('--production');
const report = validateEnv(process.env, {production});
if (report.ok) {
  console.log(production ? 'Production environment looks complete.' : 'Environment check passed for this mode.');
  process.exit(0);
}
console.error(`Environment check failed. Missing: ${report.missing.join(', ') || 'none'}. Invalid: ${report.invalid.join(', ') || 'none'}.`);
process.exit(1);
