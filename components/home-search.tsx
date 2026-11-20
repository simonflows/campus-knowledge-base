import { HomeSearchInput } from "./home-search-input";

export function HomeSearch() {
  return <HomeSearchInput basePath={process.env.BASE_PATH || ""} />;
}
