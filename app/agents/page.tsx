import {OsFrame} from '../os-frame';
import {AgentsView} from '../surfaces';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Agents">
      <AgentsView />
    </OsFrame>
  );
}
