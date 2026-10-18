import {ChatPanel} from '../chat-panel';
import {OsFrame} from '../os-frame';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <OsFrame title="Chat">
      <ChatPanel writes={null} />
    </OsFrame>
  );
}
