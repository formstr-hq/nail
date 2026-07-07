import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Loader2, Zap } from "lucide-react";
import { paymentSocket } from "../lib/api";

const MAX_TIME = 300; // the backend closes the payment socket after 5 minutes

type Status = "pending" | "paid" | "error" | "expired";

export default function InvoiceQR({
  invoice,
  hash,
  amount,
  onPaid,
}: {
  invoice: string;
  hash: string;
  amount: number;
  onPaid: () => void;
}) {
  const [status, setStatus] = useState<Status>("pending");
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState(MAX_TIME);

  useEffect(() => {
    const ws = paymentSocket(hash);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.status === "paid") {
          setStatus("paid");
          ws.close();
          onPaid();
        } else if (data.status === "error") {
          setStatus("error");
        }
      } catch {
        // ignore malformed messages
      }
    };
    ws.onerror = () => setStatus("error");

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          ws.close();
          setStatus((s) => (s === "pending" ? "expired" : s));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      ws.close();
      clearInterval(timer);
    };
    // onPaid is intentionally not a dependency — reconnecting the payment
    // socket mid-wait would make the backend reject it as a duplicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const copyInvoice = () => {
    navigator.clipboard.writeText(invoice).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p className="text-sm text-gray-600">
        Scan with a Lightning wallet to pay{" "}
        <span className="font-semibold text-ink">{amount} sats</span>.
      </p>

      <div className="rounded-2xl border border-black/10 bg-white p-4">
        <QRCodeSVG value={invoice} size={216} />
      </div>

      <div className="flex w-full items-center gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-black/[0.04] px-3 py-2 text-left font-mono text-xs text-gray-600">
          {invoice}
        </pre>
        <button
          onClick={copyInvoice}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-black/[0.04]"
        >
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {status === "pending" && (
        <p className="inline-flex items-center gap-2 text-sm text-gray-500">
          <Loader2 size={15} className="animate-spin text-primary" />
          Waiting for payment… expires in {mm}:{ss}
        </p>
      )}
      {status === "paid" && (
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-600">
          <Zap size={15} /> Payment received!
        </p>
      )}
      {status === "expired" && (
        <p className="text-sm font-semibold text-red-600">
          The invoice expired. Close this and try again.
        </p>
      )}
      {status === "error" && (
        <p className="text-sm font-semibold text-red-600">
          Something went wrong while watching for the payment. If you already
          paid, your mailbox is still being provisioned — try the sign-in check
          again in a minute.
        </p>
      )}
    </div>
  );
}
