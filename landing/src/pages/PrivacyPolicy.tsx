import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Navbar, Footer } from "../App";
import content from "./privacy-policy.md?raw";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
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
