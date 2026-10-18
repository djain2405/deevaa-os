import {BlueprintPanel} from '../blueprint-panel';
import {OsFrame} from '../os-frame';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Life Blueprint">
      <BlueprintPanel onSaved={() => undefined} />
    </OsFrame>
  );
}
