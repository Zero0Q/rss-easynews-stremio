const { addonBuilder } = require('stremio-addon-sdk');
const EasynewsSearcher = require('./easynews-searcher');
const TMDBHandler = require('./tmdb-handler');
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

const manifest = {
    id: 'org.stremio.easynews',
    version: '1.0.0',
    name: 'Easynews',
    description: 'Stream movies and series from Easynews with high quality sources',
    
    resources: [
        "catalog",
        {
            name: "meta",
            types: ["movie", "series"],
            idPrefixes: ["easynews"]
        },
        {
            name: "stream",
            types: ["movie", "series"],
            idPrefixes: ["tt", "tmdb", "easynews"]
        }
    ],

    catalogs: [
        {
            type: 'movie',
            id: 'easynews-movie-catalog',
            name: 'Easynews Movies',
            extra: [{ name: 'search', isRequired: true }]
        },
        {
            type: 'series',
            id: 'easynews-series-catalog',
            name: 'Easynews Series',
            extra: [{ name: 'search', isRequired: true }]
        }
    ],

    types: ["movie", "series"],

    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },

    config: [
        {
            key: 'username',
            type: 'text',
            title: 'Easynews Username',
            required: true
        },
        {
            key: 'password',
            type: 'password',
            title: 'Easynews Password',
            required: true
        }
    ]
};

function generatePoster(content) {
    const getBackgroundColor = (quality) => {
        switch(quality) {
            case '4K': return '#2c3e50';
            case '1080p': return '#34495e';
            case '720p': return '#2c3e50';
            case '480p': return '#7f8c8d';
            default: return '#95a5a6';
        }
    };

    const bestQuality = Array.from(content.qualities).sort((a, b) => {
        const order = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'SD': 0 };
        return (order[b] || 0) - (order[a] || 0);
    })[0];

    const backgroundColor = getBackgroundColor(bestQuality);
    
    let titleLines = [];
    let words = content.title.split(' ');
    let currentLine = '';
    
    words.forEach(word => {
        if ((currentLine + ' ' + word).length > 15) {
            titleLines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = currentLine ? currentLine + ' ' + word : word;
        }
    });
    if (currentLine) {
        titleLines.push(currentLine);
    }

    if (titleLines.length > 3) {
        titleLines = titleLines.slice(0, 3);
        titleLines[2] += '...';
    }

    return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">
            <rect width="100%" height="100%" fill="${backgroundColor}"/>
            <circle cx="150" cy="100" r="50" fill="#e74c3c"/>
            <text x="150" y="100" font-family="Arial" font-size="24" fill="white" text-anchor="middle" dominant-baseline="middle">${bestQuality}</text>
            ${titleLines.map((line, i) => 
                `<text x="150" y="${220 + i * 30}" font-family="Arial" font-size="24" fill="white" text-anchor="middle">${line}</text>`
            ).join('')}
            <text x="150" y="350" font-family="Arial" font-size="20" fill="white" text-anchor="middle">
                ${content.type === 'series' 
                    ? `S${content.season.toString().padStart(2, '0')}E${content.episode.toString().padStart(2, '0')}`
                    : content.year || ''}
            </text>
            <text x="150" y="400" font-family="Arial" font-size="16" fill="white" text-anchor="middle">
                ${content.streams.length} sources
            </text>
            <text x="150" y="430" font-family="Arial" font-size="14" fill="white" text-anchor="middle">
                ${Array.from(content.qualities).join(', ')}
            </text>
        </svg>
    `.trim();
}

function createStream(result) {
    return {
        name: `${result.quality} ${result.qualityEmoji} [${result.fileSize}]`,
        title: result.filename,
        url: result.linkUrl,
        behaviorHints: {
            notWebReady: true,
            bingeGroup: `easynews-${result.quality}`,
            proxyHeaders: {
                request: {
                    "User-Agent": "Stremio",
                    "Authorization": `Basic ${Buffer.from(`${easynewsUsername}:${easynewsPassword}`).toString('base64')}`
                }
            }
        }
    };
}

function sortStreams(streams) {
    return streams.sort((a, b) => {
        const qualityOrder = { '4K': 5, '1080p': 4, '720p': 3, '480p': 2, 'SD': 1 };
        const qualityA = a.name.match(/(4K|1080p|720p|480p|SD)/i)?.[1]?.toUpperCase() || 'SD';
        const qualityB = b.name.match(/(4K|1080p|720p|480p|SD)/i)?.[1]?.toUpperCase() || 'SD';
        return (qualityOrder[qualityB] || 0) - (qualityOrder[qualityA] || 0);
    });
}

let easynewsSearcher;
let tmdbHandler;
let easynewsUsername;
let easynewsPassword;

const searchCache = new Map();
const CACHE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const { search } = extra;
    if (!search) {
        logger.info('No search query provided');
        return { metas: [] };
    }

    logger.info(`Searching Easynews catalog for: ${search}`);

    try {
        const results = await easynewsSearcher.search(search);
        if (!results || results.length === 0) {
            return { metas: [] };
        }

        const groupedContent = new Map();

        results.forEach(result => {
            const isSeries = result.season !== null && result.episode !== null;
            
            if ((type === 'movie' && isSeries) || (type === 'series' && !isSeries)) {
                return;
            }

            let key;
            if (isSeries) {
                key = `${result.title} S${result.season.toString().padStart(2, '0')}E${result.episode.toString().padStart(2, '0')}`;
            } else {
                key = result.year ? `${result.title} (${result.year})` : result.title;
            }

            key = key.replace(/\.[^/.]+$/, "");

            if (!groupedContent.has(key)) {
                groupedContent.set(key, {
                    title: result.title,
                    year: result.year,
                    season: result.season,
                    episode: result.episode,
                    type: isSeries ? 'series' : 'movie',
                    streams: [],
                    qualities: new Set()
                });
            }

            const content = groupedContent.get(key);
            content.streams.push(result);
            content.qualities.add(result.quality);
        });

        // Cache results
        for (const [key, value] of groupedContent.entries()) {
            const cacheKey = `easynews:${encodeURIComponent(key)}`;
            searchCache.set(cacheKey, {
                streams: value.streams,
                timestamp: Date.now()
            });
        }

        const metas = Array.from(groupedContent.entries()).map(([key, content]) => {
            const posterSvg = generatePoster(content);
            const posterUrl = `data:image/svg+xml;base64,${Buffer.from(posterSvg).toString('base64')}`;

            return {
                id: `easynews:${encodeURIComponent(key)}`,
                type: content.type,
                name: content.title,
                poster: posterUrl,
                posterShape: 'regular',
                releaseInfo: content.type === 'series' 
                    ? `S${content.season} E${content.episode}` 
                    : content.year?.toString() || '',
                description: content.type === 'series'
                    ? `${content.title}\nSeason ${content.season} Episode ${content.episode}\n` +
                      `Available in: ${Array.from(content.qualities).join(', ')}\n` +
                      `Sources: ${content.streams.length}`
                    : `${content.title}\n` +
                      `Available in: ${Array.from(content.qualities).join(', ')}\n` +
                      `Sources: ${content.streams.length}`
            };
        });

        metas.sort((a, b) => {
            const yearA = parseInt(a.releaseInfo) || 0;
            const yearB = parseInt(b.releaseInfo) || 0;
            return yearB - yearA;
        });

        return { 
            metas,
            cacheMaxAge: 3600,
            staleRevalidate: 1800,
            staleError: 7200
        };
    } catch (error) {
        logger.error(`Error in catalog handler: ${error.message}`);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    logger.info(`Meta request for ${id}`);

    try {
        if (id.startsWith('easynews:')) {
            const searchTerm = decodeURIComponent(id.replace('easynews:', ''));
            logger.info(`Processing meta for: ${searchTerm}`);

            // Get from cache if available
            const cached = searchCache.get(id);
            if (cached && cached.streams && cached.streams.length > 0) {
                const result = cached.streams[0];
                logger.info(`Using cached info for: ${searchTerm}`);
                return {
                    meta: {
                        id: id,
                        type: type,
                        name: type === 'series' ? 
                            `${result.title} S${result.season.toString().padStart(2, '0')}E${result.episode.toString().padStart(2, '0')}` :
                            result.title,
                        year: result.year || undefined
                    }
                };
            }

            // Basic meta from search term
            return {
                meta: {
                    id: id,
                    type: type,
                    name: searchTerm
                }
            };
        }

        return { meta: null };
    } catch (error) {
        logger.error(`Error in meta handler: ${error.message}`);
        return { meta: null };
    }
});

builder.defineStreamHandler(async ({ type, id }) => {
    logger.info(`Stream request for ${id}`);

    try {
        let results = [];

        if (id.startsWith('easynews:')) {
            const cached = searchCache.get(id);
            if (cached && (Date.now() - cached.timestamp) < CACHE_TIMEOUT) {
                results = cached.streams;
                logger.info(`Using ${results.length} cached streams for ${id}`);
            } else {
                const searchTerm = decodeURIComponent(id.replace('easynews:', ''));
                const cleanSearchTerm = searchTerm.replace(/\.[^/.]+$/, "");
                logger.info(`Searching with term: ${cleanSearchTerm}`);
                results = await easynewsSearcher.search(cleanSearchTerm);
            }
        } else if ((id.startsWith('tt') || id.startsWith('tmdb')) && tmdbHandler) {
            try {
                const [baseId, seasonNum, episodeNum] = id.split(':');
                const metadata = await tmdbHandler.getMetadata(baseId, type);
                if (!metadata) {
                    logger.error(`Unable to find metadata for ${baseId}`);
                    return { streams: [] };
                }

                const title = metadata.title || metadata.name;
                let year = null;

                if (type === 'movie' && metadata.release_date) {
                    year = new Date(metadata.release_date).getFullYear();
                } else if (type === 'series' && metadata.first_air_date) {
                    year = new Date(metadata.first_air_date).getFullYear();
                }

                let searchTerm;
                if (type === 'series' && seasonNum && episodeNum) {
                    searchTerm = `${title} S${seasonNum.padStart(2, '0')}E${episodeNum.padStart(2, '0')}`;
                    logger.info(`Searching for series episode: ${searchTerm}`);
                } else if (type === 'movie') {
                    searchTerm = year ? `${title} ${year}` : title;
                    logger.info(`Searching for movie: ${searchTerm}`);
                } else {
                    searchTerm = title;
                    logger.info(`Searching with basic title: ${searchTerm}`);
                }

                results = await easynewsSearcher.search(searchTerm);

                if (results.length === 0 && type === 'movie' && year) {
                    logger.info(`No results found with year, trying without year: ${title}`);
                    results = await easynewsSearcher.search(title);
                }
            } catch (error) {
                logger.error(`TMDB error: ${error.message}. Falling back to ID-based search.`);
                results = await handleIdBasedSearch(id, type);
            }
        } else {
            results = await handleIdBasedSearch(id, type);
        }

        const streams = sortStreams(results.map(createStream));
        logger.info(`Returning ${streams.length} streams for ${id}`);

        return { 
            streams,
            cacheMaxAge: 3600,
            staleRevalidate: 1800,
            staleError: 7200
        };
    } catch (error) {
        logger.error(`Error in stream handler: ${error.message}`);
        return { streams: [] };
    }
});

async function handleIdBasedSearch(id, type) {
    const [baseId, seasonNum, episodeNum] = id.split(':');
    let searchTerm;

    if (type === 'series' && seasonNum && episodeNum) {
        searchTerm = `${baseId} S${seasonNum.padStart(2, '0')}E${episodeNum.padStart(2, '0')}`;
        logger.info(`Searching for series episode without TMDB: ${searchTerm}`);
    } else {
        searchTerm = baseId;
        logger.info(`Searching with ID only: ${searchTerm}`);
    }

    return await easynewsSearcher.search(searchTerm);
}

function setConfiguration(config) {
    try {
        logger.info('Received configuration:', JSON.stringify({
            ...config,
            username: config.username ? '[REDACTED]' : undefined,
            password: config.password ? '[REDACTED]' : undefined
        }));

        const { username, password } = config;
        easynewsUsername = username;
        easynewsPassword = password;

        easynewsSearcher = new EasynewsSearcher(username, password);

        const TMDB_API_KEY = process.env.TMDB_API_KEY || 'f051e7366c6105ad4f9aafe4733d9dae';

        if (TMDB_API_KEY) {
            try {
                tmdbHandler = new TMDBHandler(TMDB_API_KEY);
                logger.info('TMDB handler initialized with API key');
            } catch (error) {
                logger.warn('Failed to initialize TMDB handler:', error.message);
                tmdbHandler = null;
            }
        } else {
            logger.warn('No TMDB API key available - TMDB features will be disabled');
            tmdbHandler = null;
        }

        logger.info('Configuration set for Easynews searcher');
        return builder.getInterface();
    } catch (error) {
        logger.error('Error in setConfiguration:', error);
        throw error;
    }
}

module.exports = { setConfiguration };