import { useState, useRef, useEffect } from 'react';

const useAutoHideControls = (delay = 3000) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const show = () => {
    setVisible(true);
    console.log("Curson In")
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setVisible(false), delay);
  };

  const hide = () => {
    setVisible(false);
    console.log("Cursor out")
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { visible, show, hide };
};

export default useAutoHideControls;