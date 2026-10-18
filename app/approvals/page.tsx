import {OsFrame} from '../os-frame';
import {ApprovalsView} from '../surfaces';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Approvals">
      <ApprovalsView />
    </OsFrame>
  );
}
