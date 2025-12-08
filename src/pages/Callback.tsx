import { useEffect, useRef } from "react";
import { handleCallback } from "../auth";

export default function Callback() {
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // ← ガード
    once.current = true;

    (async () => {
      try {
        await handleCallback();
      } catch (e) {
        console.error(e);
        alert((e as Error).message);
      } finally {
        location.replace("/"); // トップへ戻す
      }
    })();
  }, []);

  return <p style={{ padding: 24 }}>認可処理中...</p>;
}
