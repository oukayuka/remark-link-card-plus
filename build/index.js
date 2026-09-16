import { createHash } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import client from "open-graph-scraper";
import sanitizeHtml from "sanitize-html";
import { visit } from "unist-util-visit";
const defaultSaveDirectory = "public";
const defaultOutputDirectory = "/remark-link-card-plus/";
const defaultOptions = {
    cache: false,
    shortenUrl: true,
    thumbnailPosition: "right",
    noThumbnail: false,
    noFavicon: false,
    ignoreExtensions: [],
};
const SELF_PREFIX = "self://";
const isRelativePath = (urlString) => {
    return (urlString.startsWith("/") ||
        urlString.startsWith("./") ||
        urlString.startsWith("../"));
};
const resolveImageUrl = (urlString, baseUrl) => {
    if (!urlString || urlString.length === 0)
        return undefined;
    if (urlString.startsWith(SELF_PREFIX)) {
        return urlString.slice(SELF_PREFIX.length);
    }
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return urlString;
        }
        return undefined;
    }
    catch (_) { }
    if (!isRelativePath(urlString)) {
        return undefined;
    }
    try {
        return new URL(urlString, baseUrl).toString();
    }
    catch (error) {
        console.error(`[remark-link-card-plus] Error: Failed to resolve URL ${urlString} relative to ${baseUrl}\n${error}`);
        return undefined;
    }
};
const remarkLinkCard = (userOptions) => async (tree) => {
    const options = { ...defaultOptions, ...userOptions };
    const transformers = [];
    const shouldIgnoreUrl = (url) => {
        if (!options.ignoreExtensions?.length)
            return false;
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname.toLowerCase();
            return options.ignoreExtensions.some((ext) => pathname.endsWith(ext.toLowerCase()));
        }
        catch (_) {
            return false;
        }
    };
    const addTransformer = (url, index) => {
        transformers.push(async () => {
            const data = await getLinkCardData(new URL(url), options);
            const linkCardNode = createLinkCardNode(data, options);
            if (index !== undefined) {
                tree.children.splice(index, 1, linkCardNode);
            }
        });
    };
    const isValidUrl = (value) => {
        if (!URL.canParse(value))
            return false;
        const basicUrlPattern = /^(https?:\/\/[^\s/$.?#].[^\s]*)$/i;
        if (!basicUrlPattern.test(value))
            return false;
        return true;
    };
    visit(tree, "paragraph", (paragraph, index, parent) => {
        if (parent?.type !== "root" || paragraph.children.length !== 1)
            return;
        let unmatchedLink;
        let processedUrl;
        visit(paragraph, "link", (linkNode) => {
            const hasOneChildText = linkNode.children.length === 1 &&
                linkNode.children[0].type === "text";
            if (!hasOneChildText)
                return;
            const childText = linkNode.children[0];
            if (!isSameUrlValue(linkNode.url, childText.value)) {
                unmatchedLink = linkNode;
                return;
            }
            if (index !== undefined) {
                processedUrl = linkNode.url;
                if (!shouldIgnoreUrl(linkNode.url)) {
                    addTransformer(linkNode.url, index);
                }
            }
        });
        visit(paragraph, "text", (textNode) => {
            if (!isValidUrl(textNode.value))
                return;
            if (processedUrl === textNode.value)
                return;
            // NOTE: Skip card conversion if the link text and URL are different, e.g., [https://example.com](https://example.org)
            if (unmatchedLink &&
                textNode.value === unmatchedLink.children[0].value &&
                textNode.position?.start.line === unmatchedLink.position?.start.line) {
                return;
            }
            if (index !== undefined) {
                if (!shouldIgnoreUrl(textNode.value)) {
                    addTransformer(textNode.value, index);
                }
            }
        });
    });
    try {
        await Promise.all(transformers.map((t) => t()));
    }
    catch (error) {
        console.error(`[remark-link-card-plus] Error: ${error}`);
    }
    return tree;
};
const isSameUrlValue = (a, b) => {
    try {
        return new URL(a).toString() === new URL(b).toString();
    }
    catch (_) {
        return false;
    }
};
const getOpenGraph = async (targetUrl) => {
    try {
        const { result } = await client({
            url: targetUrl.toString(),
            timeout: 10000,
        });
        return result;
    }
    catch (error) {
        const ogError = error;
        console.error(`[remark-link-card-plus] Error: Failed to get the Open Graph data of ${ogError?.result?.requestUrl} due to ${ogError?.result?.error}.`);
        return undefined;
    }
};
const getFaviconImageSrc = async (url) => {
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${url.hostname}`;
    const res = await fetch(faviconUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
        return "";
    return faviconUrl;
};
const getLinkCardData = async (url, options) => {
    const ogRawResult = await getOpenGraph(url);
    let ogData = {
        title: ogRawResult?.ogTitle || "",
        description: ogRawResult?.ogDescription || "",
        faviconUrl: ogRawResult?.favicon,
        imageUrl: extractOgImageUrl(ogRawResult),
    };
    if (options.ogTransformer) {
        ogData = options.ogTransformer(ogData, url);
    }
    const title = ogData?.title || url.hostname;
    const description = ogData?.description || "";
    const faviconUrl = await getFaviconUrl(url, ogData?.faviconUrl, options);
    const ogImageUrl = await getOgImageUrl(url, ogData.imageUrl, options);
    let displayUrl = options.shortenUrl ? url.hostname : url.toString();
    try {
        displayUrl = decodeURI(displayUrl);
    }
    catch (error) {
        console.error(`[remark-link-card-plus] Error: Cannot decode url: "${url}"\n ${error}`);
    }
    return {
        title,
        description,
        faviconUrl,
        ogImageUrl,
        displayUrl,
        url,
    };
};
const getFaviconUrl = async (url, ogFavicon, options) => {
    if (options.noFavicon)
        return "";
    const isSelfUrl = ogFavicon?.startsWith(SELF_PREFIX);
    let faviconUrl = resolveImageUrl(ogFavicon, url);
    if (!faviconUrl) {
        faviconUrl = await getFaviconImageSrc(url);
    }
    if (faviconUrl && options.cache && !isSelfUrl) {
        try {
            const faviconFilename = await getCachedImageFilename(new URL(faviconUrl), path.join(process.cwd(), defaultSaveDirectory, defaultOutputDirectory));
            faviconUrl = faviconFilename
                ? path.join(defaultOutputDirectory, faviconFilename)
                : faviconUrl;
        }
        catch (error) {
            console.error(`[remark-link-card-plus] Error: Failed to download favicon from ${faviconUrl}\n ${error}`);
        }
    }
    return faviconUrl;
};
const getOgImageUrl = async (url, imageUrl, options) => {
    if (options.noThumbnail)
        return "";
    const resolvedImageUrl = resolveImageUrl(imageUrl, url);
    if (!resolvedImageUrl)
        return "";
    const isSelfUrl = imageUrl?.startsWith(SELF_PREFIX);
    let ogImageUrl = resolvedImageUrl;
    if (ogImageUrl && options.cache && !isSelfUrl) {
        const imageFilename = await getCachedImageFilename(new URL(ogImageUrl), path.join(process.cwd(), defaultSaveDirectory, defaultOutputDirectory));
        ogImageUrl = imageFilename
            ? path.join(defaultOutputDirectory, imageFilename)
            : ogImageUrl;
    }
    return ogImageUrl;
};
const extractOgImageUrl = (ogResult) => {
    return ogResult?.ogImage && ogResult.ogImage.length > 0
        ? ogResult.ogImage[0].url
        : undefined;
};
const getCachedImageFilename = async (url, saveDirectory) => {
    const hash = createHash("sha256").update(decodeURI(url.href)).digest("hex");
    try {
        const files = await readdir(saveDirectory);
        const cachedFile = files.find((file) => file.startsWith(`${hash}.`));
        if (cachedFile) {
            return cachedFile;
        }
    }
    catch (_) { }
    try {
        const response = await fetch(url.href, {
            signal: AbortSignal.timeout(10000),
        });
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = response.headers.get("Content-Type");
        let extension = "";
        // NOTE: file-type cannot detect text-based formats like SVG, so we handle image/svg+xml manually
        if (contentType?.startsWith("image/svg+xml")) {
            extension = ".svg";
        }
        else if (contentType?.startsWith("image/")) {
            const fileType = await fileTypeFromBuffer(buffer);
            extension = fileType ? `.${fileType.ext}` : ".png";
        }
        const filename = `${hash}${extension}`;
        const saveFilePath = path.join(saveDirectory, filename);
        try {
            await access(saveDirectory);
        }
        catch (_) {
            await mkdir(saveDirectory, { recursive: true });
        }
        await writeFile(saveFilePath, buffer);
        return filename;
    }
    catch (error) {
        console.error(`[remark-link-card-plus] Error: Failed to download image from ${url.href}\n ${error}`);
        return undefined;
    }
};
const className = (value) => {
    const prefix = "remark-link-card-plus";
    return `${prefix}__${value}`;
};
const createLinkCardNode = (data, options) => {
    const { title, description, faviconUrl, ogImageUrl, displayUrl, url } = data;
    const isThumbnailLeft = options.thumbnailPosition === "left";
    const thumbnail = ogImageUrl
        ? `
<div class="${className("thumbnail")}">
  <img src="${ogImageUrl}" class="${className("image")}" alt="">
</div>`.trim()
        : "";
    const mainContent = `
<div class="${className("main")}">
  <div class="${className("content")}">
    <div class="${className("title")}">${sanitizeHtml(title)}</div>
    <div class="${className("description")}">${sanitizeHtml(description)}</div>
  </div>
  <div class="${className("meta")}">
    ${faviconUrl ? `<img src="${faviconUrl}" class="${className("favicon")}" width="14" height="14" alt="">` : ""}
    <span class="${className("url")}">${sanitizeHtml(displayUrl)}</span>
  </div>
</div>
`
        .replace(/\n\s*\n/g, "\n")
        .trim();
    const content = isThumbnailLeft
        ? `
${thumbnail}
${mainContent}`
        : `
${mainContent}
${thumbnail}`;
    return {
        type: "html",
        value: `
<div class="${className("container")}">
  <a href="${url.toString()}" target="_blank" rel="noreferrer noopener" class="${className("card")}">
    ${content.trim()}
  </a>
</div>
`.trim(),
    };
};
export default remarkLinkCard;
//# sourceMappingURL=index.js.map