const { MovieDb } = require('moviedb-promise');
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

class TMDBHandler {
    constructor(apiKey) {
        this.tmdb = new MovieDb(apiKey);
    }

    async getMetadata(id, type) {
        try {
            logger.info(`Fetching metadata for ID: ${id}, Type: ${type}`);
            let result;
            let tmdbId;

            if (id.startsWith('tt')) {
                // It's an IMDb ID, need to find it in TMDB first
                logger.info(`Searching TMDB for IMDb ID: ${id}`);
                const searchResult = await this.tmdb.find({ id: id, external_source: 'imdb_id' });
                if (searchResult.movie_results && searchResult.movie_results.length > 0) {
                    tmdbId = searchResult.movie_results[0].id;
                    type = 'movie';
                } else if (searchResult.tv_results && searchResult.tv_results.length > 0) {
                    tmdbId = searchResult.tv_results[0].id;
                    type = 'series';
                }
            } else if (id.startsWith('tmdb-')) {
                tmdbId = id.split('-')[1];  // Remove the 'tmdb-' prefix
            } else {
                tmdbId = id;
            }

            if (!tmdbId) {
                throw new Error('Unable to determine TMDB ID');
            }

            logger.info(`Fetching TMDB info for ID: ${tmdbId}, Type: ${type}`);
            if (type === 'movie') {
                result = await this.tmdb.movieInfo({ id: tmdbId });
            } else if (type === 'series') {
                result = await this.tmdb.tvInfo({ id: tmdbId });
            } else {
                throw new Error('Invalid type. Must be "movie" or "series".');
            }

            if (!result) {
                throw new Error('No results found');
            }

            logger.info(`Successfully fetched metadata for ${id}`);
            return result;
        } catch (error) {
            logger.error(`Error fetching metadata: ${error.message}`);
            return null;
        }
    }

    async getImdbId(tmdbId, type) {
        try {
            logger.info(`Fetching IMDb ID for TMDB ID: ${tmdbId}`);
            let result;
            if (type === 'movie') {
                result = await this.tmdb.movieExternalIds(tmdbId);
            } else if (type === 'series') {
                result = await this.tmdb.tvExternalIds(tmdbId);
            } else {
                throw new Error('Invalid type. Must be "movie" or "series".');
            }

            logger.info(`Successfully fetched IMDb ID for TMDB ID: ${tmdbId}`);
            return result.imdb_id;
        } catch (error) {
            logger.error(`Error fetching IMDB ID: ${error.message}`);
            return null;
        }
    }

    async searchByTitle(title, type) {
        try {
            logger.info(`Searching TMDB by title: ${title}`);
            let results;
            if (type === 'movie') {
                results = await this.tmdb.searchMovie({ query: title });
            } else if (type === 'series') {
                results = await this.tmdb.searchTv({ query: title });
            } else {
                throw new Error('Invalid type. Must be "movie" or "series".');
            }

            if (results.results && results.results.length > 0) {
                const tmdbId = results.results[0].id;
                logger.info(`Found TMDB ID: ${tmdbId} for title: ${title}`);
                return await this.getImdbId(tmdbId, type);
            }
            logger.warn(`No results found for title: ${title}`);
            return null;
        } catch (error) {
            logger.error(`Error searching by title: ${error.message}`);
            return null;
        }
    }
}

module.exports = TMDBHandler;
