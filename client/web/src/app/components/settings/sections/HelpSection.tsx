import { ChevronRightIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'

export function HelpSection() {
  return (
    <>
      <Field
        label="Privacy policy"
        hint="How Mail by Formstr handles your data — what we store, what we don't, and how Lightning payments work."
      >
        <a
          href="/privacy-policy"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-md border border-input bg-background px-3 text-[13px] font-medium text-foreground transition-colors duration-[120ms] hover:bg-accent"
        >
          Read the privacy policy
          <ChevronRightIcon className="h-4 w-4" />
        </a>
      </Field>

      <Field
        label="Contact us"
        hint="Questions, feedback, or account issues — send us a message."
      >
        <a
          href="https://formstr.app/f/naddr1qvzqqqr4mqpzphj4jjc6qkaaswuz6wu3kzyvhhdu5e68rdfymj2dtmk5eajwvx2mqyt8wumn8ghj7un9d3shjtnddaehgu3wwp6kytcprfmhxue69uhhyetvv9ujuurjd9kkzmpwdejhgtmkxyhsz9thwden5te0wfjkccte9ejxzmt4wvhxjme0qys8wumn8ghj7mn0wd68ytn9d9h82mny0fmkzmn6d9njuumsv93k2tcpzamhxue69uhhyetvv9ujuurjd9kkzmpwdejhgtcpp4mhxue69uhkummn9ekx7mqpremhxue69uhhyetvv9ujumn0wd68ytnhd9ex2erwv46zu6ns9uq3camnwvaz7tmwdaehgu3dxqcju7tpdd5ksmmwdejjucm0d5q3samnwvaz7tmjv4kxz7fwwdhx7un59eek7cmfv9kqz9nhwden5te0wfjkccte9ehx7um5wghxyctwvsq3zamnwvaz7tmwdaehgu3jxyhxxmmdqqryk4ttwe3yjmmync4?viewKey=4425edf8b0c0ab84f47718452c6dd0fcfb6df2ec73ad868b31eefe0f18abc8f8"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-md border border-input bg-background px-3 text-[13px] font-medium text-foreground transition-colors duration-[120ms] hover:bg-accent"
        >
          Open contact form
          <ChevronRightIcon className="h-4 w-4" />
        </a>
      </Field>
    </>
  )
}