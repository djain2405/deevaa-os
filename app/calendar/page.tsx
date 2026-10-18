import {OsFrame} from '../os-frame';
import {CalendarView} from '../surfaces';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Calendar">
      <CalendarView />
    </OsFrame>
  );
}
