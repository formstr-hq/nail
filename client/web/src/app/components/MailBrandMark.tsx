import { useAppDesk } from "@formstr/common-ui";
import { BrandGlyph } from "@/app/components/ui/icons";

/**
 * The Mail mark with its asterisk as the suite door. The envelope stays the
 * brand; only the asterisk overhangs opens the drawer.
 */
export function MailBrandMark({ size = 24 }: { size?: number }) {
  const openDesk = useAppDesk();

  return (
    <span className="relative inline-flex">
      <BrandGlyph size={size} />
      <button
        type="button"
        aria-label="Open the Formstr app desk"
        title="Formstr app desk"
        onClick={(event) => {
          event.stopPropagation();
          openDesk(event.currentTarget);
        }}
        className="absolute left-[48%] top-[10%] z-10 h-[44%] w-[40%] cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-emphasis)]"
      />
    </span>
  );
}
