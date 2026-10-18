import {OsFrame} from '../os-frame';
import {SettingsPanel} from '../settings-panel';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Settings">
      <SettingsPanel />
    </OsFrame>
  );
}
