import {OsFrame} from '../os-frame';
import {MemoryView} from '../surfaces';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Memory">
      <MemoryView />
    </OsFrame>
  );
}
