import { HomeSearchInput } from "./home-search-input";

export function HomeSearch({ examples }: { examples: string[] }) {
  return (
    <HomeSearchInput basePath={process.env.BASE_PATH || ""} examples={examples} />
  );
}
