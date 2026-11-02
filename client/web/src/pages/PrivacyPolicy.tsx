import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Navbar, Footer } from "../components/landing";
// Aliased at build time (vite.config.ts): store builds get the variant that
// describes store billing and names no other payment method.
import content from "@privacy-policy.md?raw";

export default function PrivacyPolicy() {
  return (
    <div className="safe-y min-h-screen bg-white text-gray-900">
      <Navbar />
      <main className="mx-auto max-w-3xl px-6 py-20">
        <article className="prose prose-gray max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </article>
      </main>
      <Footer />
    </div>
  );
}
