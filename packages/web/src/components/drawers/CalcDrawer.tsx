import { Drawer } from 'antd';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { DialogId } from '../../state/state';
import { useCalc } from '../../state/store';

/** Drawer width: 520 px, the viewport on narrower screens (demo v8 `dw`). */
function useDrawerWidth(): number {
  const [w, setW] = useState(() => Math.min(520, window.innerWidth));
  useEffect(() => {
    const on = () => setW(Math.min(520, window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

type Props = {
  id: DialogId;
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  /** Runs before the store closes the dialog (e.g. drop a model that waits for this Drawer). */
  onClose?: () => void;
  /** Called when the open state changes, after the animation (antd afterOpenChange). */
  afterOpenChange?: (open: boolean) => void;
};

/** One of the store's dialogs as a right-hand Drawer (design §3.3: lists and forms go in a Drawer). */
export function CalcDrawer({ id, title, extra, children, onClose, afterOpenChange }: Props): JSX.Element {
  const [{ dialog }, dispatch] = useCalc();
  const size = useDrawerWidth();
  return (
    <Drawer
      title={title}
      extra={extra}
      open={dialog === id}
      size={size}
      afterOpenChange={afterOpenChange}
      // Forms start again from the current inputs every time the Drawer opens.
      destroyOnHidden
      onClose={() => {
        onClose?.();
        dispatch({ type: 'dialog', id: null });
      }}
    >
      {children}
    </Drawer>
  );
}
