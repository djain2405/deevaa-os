import {OsFrame} from '../os-frame';
import {ProjectsView} from '../surfaces';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Projects">
      <ProjectsView />
    </OsFrame>
  );
}
