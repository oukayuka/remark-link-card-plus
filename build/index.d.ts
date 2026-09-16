import type { Root } from "mdast";
import type { Plugin } from "unified";
export type OgData = {
    title: string;
    description: string;
    faviconUrl?: string;
    imageUrl?: string;
};
type Options = {
    cache?: boolean;
    shortenUrl?: boolean;
    thumbnailPosition?: "right" | "left";
    noThumbnail?: boolean;
    noFavicon?: boolean;
    ogTransformer?: (og: OgData, url: URL) => OgData;
    ignoreExtensions?: string[];
};
declare const remarkLinkCard: Plugin<[Options], Root>;
export default remarkLinkCard;
