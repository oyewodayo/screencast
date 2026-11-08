// hooks/usePhonePreview.ts
//
// "Phone preview" (the Canvas panel's switch): the player shows a phone-shaped canvas as the
// phone's screen - its corners and camera cut-out, and where a vertical app's buttons and captions
// will sit over the video (PhonePreviewLayer). A viewing preference, remembered per machine and
// shared live between the panel and the player.
import { useEffect, useState } from "react";

const KEY = "briefcast.phonePreview";
const EVENT = "briefcast:phone-preview";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

export function usePhonePreview(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // Not remembered - still applies for now.
    }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}
