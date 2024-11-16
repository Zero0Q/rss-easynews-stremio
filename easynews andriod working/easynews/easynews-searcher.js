const fetch = require('node-fetch');
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

class EasynewsSearcher {
    constructor(username, password, maxRetries = 3, retryDelay = 1000) {
        this.username = username;
        this.password = password;
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
        this.maxFileSize = 100; // Maximum file size in GB
    }

    getSearchUrl(searchTerm) {
        const encodedSearchTerm = encodeURIComponent(searchTerm);
        return `https://members.easynews.com/1.0/global5/search.html?submit=Search&gps=&sbj=&from=&ns=&fil=${encodedSearchTerm}&fex=&vc=&ac=&fty%5B%5D=VIDEO&s1=dtime&s1d=-&s2=nsubject&s2d=%2B&s3=nrfile&s3d=%2B&pby=1000&pno=1&sS=5&u=1&svL=&d1=&d1t=&d2=&d2t=&b1=&b1t=&b2=&b2t=&px1=&px1t=&px2=&px2t=&fps1=&fps1t=&fps2=&fps2t=&bps1=&bps1t=&bps2=&bps2t=&hz1=&hz1t=&hz2=&hz2t=&rn1=&rn1t=&rn2=&rn2t=&fly=1`;
    }

    detectQuality(filename) {
        const qualityPatterns = [
            {
                quality: '4K',
                patterns: [/2160p/i, /4K/i, /UHD/i, /ULTRA.?HD/i]
            },
            {
                quality: '1080p',
                patterns: [/1080[pi]/i, /FHD/i, /FULL.?HD/i]
            },
            {
                quality: '720p',
                patterns: [/720p/i, /HD(?!TV)/i]
            },
            {
                quality: '480p',
                patterns: [/480[pi]/i, /SD\b/i]
            }
        ];

        for (const { quality, patterns } of qualityPatterns) {
            if (patterns.some(pattern => pattern.test(filename))) {
                return quality;
            }
        }

        // Default quality if no match found
        return 'SD';
    }

    getQualityEmoji(quality) {
        const emojiMap = {
            '4K': '🌟',
            '1080p': '🎥',
            '720p': '📺',
            '480p': '📱',
            'SD': '💾'
        };
        return emojiMap[quality] || '📺';
    }

    detectLanguagesFromFilename(filename) {
        const languagePatterns = {
            'English': [
                /\bENG\b/i,
                /\bENGLISH\b/i,
                /\bEN\b/i,
                /\bDUAL[._]AUDIO\b/i
            ],
            'French': [
                /\bFR\b/i,
                /\bFRENCH\b/i,
                /\bVFF\b/i,
                /\bTRUEFRENCH\b/i
            ],
            'German': [
                /\bGER(MAN)?\b/i,
                /\bDEU\b/i
            ],
            'Spanish': [
                /\bESP\b/i,
                /\bSPA(NISH)?\b/i
            ],
            'Italian': [
                /\bITA(LIAN)?\b/i
            ],
            'Multi': [
                /\bMULTI\b/i,
                /\bMULTILANGUAGE\b/i,
                /\bDUAL[._]AUDIO\b/i
            ],
            'Nordic': [
                /\bNORDIC\b/i,
                /\bNORDiC\b/i
            ]
        };

        const languages = new Set();
        
        for (const [language, patterns] of Object.entries(languagePatterns)) {
            if (patterns.some(pattern => pattern.test(filename))) {
                languages.add(language);
            }
        }

        return Array.from(languages);
    }

    getLanguageFromCode(code) {
        const languageMap = {
            'us': 'English',
            'gb': 'English',
            'ca': 'English',
            'au': 'English',
            'nz': 'English',
            'fr': 'French',
            'de': 'German',
            'es': 'Spanish',
            'it': 'Italian',
            'jp': 'Japanese',
            'kr': 'Korean',
            'cn': 'Chinese',
            'ru': 'Russian',
            'nl': 'Dutch',
            'pl': 'Polish',
            'se': 'Swedish',
            'dk': 'Danish',
            'no': 'Norwegian',
            'fi': 'Finnish',
            'pt': 'Portuguese',
            'br': 'Portuguese',
            'tr': 'Turkish',
            'nordic': 'Nordic'
        };
        return languageMap[code.toLowerCase()] || code;
    }

    getLanguageEmojis(languages) {
        const emojiMap = {
            'English': ['🇺🇸', '🇬🇧'],
            'French': '🇫🇷',
            'German': '🇩🇪',
            'Spanish': '🇪🇸',
            'Italian': '🇮🇹',
            'Japanese': '🇯🇵',
            'Korean': '🇰🇷',
            'Chinese': '🇨🇳',
            'Russian': '🇷🇺',
            'Dutch': '🇳🇱',
            'Polish': '🇵🇱',
            'Swedish': '🇸🇪',
            'Danish': '🇩🇰',
            'Norwegian': '🇳🇴',
            'Finnish': '🇫🇮',
            'Portuguese': '🇵🇹',
            'Turkish': '🇹🇷',
            'Nordic': '🇩🇰',
            'Multi': '🌐'
        };

        return languages.flatMap(lang => {
            const emoji = emojiMap[lang];
            return Array.isArray(emoji) ? emoji : [emoji || '🏳️'];
        });
    }

    convertToGB(fileSize) {
        const size = parseFloat(fileSize);
        const unit = fileSize.split(' ')[1]?.toLowerCase() || 'gb';
        
        switch (unit) {
            case 'kb': return size / (1024 * 1024);
            case 'mb': return size / 1024;
            case 'gb': return size;
            case 'tb': return size * 1024;
            default: return 0;
        }
    }

    extractFileInfo(filename) {
        // Clean up filename
        let cleanName = filename
            .replace(/\.[^/.]+$/, '') // Remove extension
            .replace(/\b(?:480p|720p|1080[pi]|2160p|4k|uhd|hdr|bluray|webrip|web-dl|webdl|web)\b.*$/i, '')
            .replace(/\./g, ' ')
            .replace(/-/g, ' ')
            .trim();

        // Extract year
        const yearMatch = cleanName.match(/\b(?:19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : null;
        if (year) {
            cleanName = cleanName.replace(yearMatch[0], '').trim();
        }

        // Extract season/episode
        const seasonEpMatch = cleanName.match(/S(\d{1,2})E(\d{1,2})/i);
        const season = seasonEpMatch ? parseInt(seasonEpMatch[1]) : null;
        const episode = seasonEpMatch ? parseInt(seasonEpMatch[2]) : null;

        if (season && episode) {
            cleanName = cleanName.replace(/S\d{1,2}E\d{1,2}/i, '').trim();
        }

        // Clean title
        cleanName = cleanName
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return {
            title: cleanName,
            year,
            season,
            episode
        };
    }

    parseXMLItem(itemXml) {
        try {
            // Extract URL
            const enclosureMatch = itemXml.match(/<enclosure url="([^"]+)"/);
            if (!enclosureMatch) return null;
            let url = enclosureMatch[1];
            url = this.decodeHTMLEntities(url);

            // Extract file size
            const sizeMatch = itemXml.match(/length="([^"]+)"/);
            const fileSize = sizeMatch ? this.decodeHTMLEntities(sizeMatch[1]) : '0 B';

            // Get filename from URL
            const filenameMatch = url.match(/\/([^\/]+\.(?:mkv|mp4|avi|ts))(?:\?|$)/i);
            if (!filenameMatch) return null;
            const filename = this.decodeHTMLEntities(decodeURIComponent(filenameMatch[1]));

            // Skip sample files
            if (/(^|-|\s)sample[s]?(\.|$|\s|-)/i.test(filename)) {
                logger.debug(`Skipping sample file: ${filename}`);
                return null;
            }

            // Check file size
            const sizeInGB = this.convertToGB(fileSize);
            if (sizeInGB > this.maxFileSize) {
                logger.debug(`Skipping large file: ${filename} (${fileSize})`);
                return null;
            }

            // Extract information
            const info = this.extractFileInfo(filename);

            // Extract languages from flags
            const flagCodes = new Set();
            const flagMatches = itemXml.matchAll(/flags\/16\/([^.]+)\.png/g);
            for (const match of flagMatches) {
                flagCodes.add(match[1].toLowerCase());
            }

            // Get languages
            const filenameLanguages = this.detectLanguagesFromFilename(filename);
            const flagLanguages = Array.from(flagCodes).map(code => this.getLanguageFromCode(code));
            const allLanguages = Array.from(new Set([...flagLanguages, ...filenameLanguages]));

            // Default to English for standard releases
            if (allLanguages.length === 0 && 
                /\b(?:BluRay|WEB-DL|WEBRip|BRRip|DVDRip)\b/i.test(filename) && 
                !/\b(?:FRENCH|GERMAN|SPANISH|ITALIAN|NORDIC)\b/i.test(filename)) {
                allLanguages.push('English');
            }

            // Detect quality
            const quality = this.detectQuality(filename);

            return {
                filename,
                linkUrl: url,
                fileSize,
                quality,
                qualityEmoji: this.getQualityEmoji(quality),
                languages: allLanguages,
                languageEmojis: this.getLanguageEmojis(allLanguages),
                ...info
            };
        } catch (error) {
            logger.error(`Error parsing XML item: ${error.message}`);
            return null;
        }
    }

    decodeHTMLEntities(text) {
        return text.replace(/&([^;]+);/g, (match, entity) => {
            const entities = {
                'amp': '&',
                'apos': "'",
                'lt': '<',
                'gt': '>',
                'quot': '"',
                'nbsp': ' ',
                '#046': '.',
                '#058': ':',
                '#047': '/',
                '#040': '(',
                '#041': ')',
                '#064': '@',
                '#037': '%',
                '#043': '+',
                '#061': '='
            };
            
            if (entity.startsWith('#')) {
                const code = parseInt(entity.substring(1));
                return isNaN(code) ? match : String.fromCharCode(code);
            }
            
            return entities[entity] || match;
        });
    }

    async fetchWithRetry(fetchFunction, retries = this.maxRetries) {
        try {
            return await fetchFunction();
        } catch (error) {
            if (retries > 0) {
                logger.warn(`Retrying... ${retries} attempts left`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                return this.fetchWithRetry(fetchFunction, retries - 1);
            } else {
                throw error;
            }
        }
    }

    async fetchEasynewsRssFeed(searchTerm) {
        const url = this.getSearchUrl(searchTerm);
        logger.debug(`Fetching from URL: ${url}`);
        const response = await fetch(url, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.text();
    }

    async search(searchTerm) {
        logger.info(`Searching Easynews for: ${searchTerm}`);
        try {
            const xml = await this.fetchWithRetry(() => this.fetchEasynewsRssFeed(searchTerm));
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            const results = [];
            let match;

            while ((match = itemRegex.exec(xml)) !== null) {
                const result = this.parseXMLItem(match[1]);
                if (result) {
                    results.push(result);
                }
            }

            logger.info(`Found ${results.length} results`);
            return results;
        } catch (error) {
            logger.error(`Failed to search Easynews for: ${searchTerm}`, error);
            return [];
        }
    }
}

module.exports = EasynewsSearcher;