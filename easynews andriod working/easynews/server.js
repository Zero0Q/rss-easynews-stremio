require('dotenv').config();
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const express = require('express');
const path = require('path');
const http = require('http');
const winston = require('winston');

// Configure Winston logger
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
            let logMessage = `${timestamp} ${level}: ${message}`;
            if (Object.keys(meta).length > 0) {
                logMessage += `\n${JSON.stringify(meta, null, 2)}`;
            }
            return logMessage;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

const app = express();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();
    
    logger.info(`REQUEST: ${req.method} ${req.url}`, {
        headers: req.headers,
        query: req.query,
        params: req.params,
        path: req.path
    });

    const oldSend = res.send;
    res.send = function(data) {
        const duration = Date.now() - startTime;
        
        logger.info(`RESPONSE: ${req.method} ${req.url} - Status ${res.statusCode} (${duration}ms)`, {
            statusCode: res.statusCode,
            duration: duration,
            responseHeaders: res.getHeaders()
        });
        
        oldSend.apply(res, arguments);
    };

    next();
});

// CORS middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, User-Agent');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

let routerCache = new Map();

// Function to get or create addon router
function getOrCreateRouter(configStr) {
    if (!configStr) {
        logger.warn('No configuration provided');
        return null;
    }

    if (routerCache.has(configStr)) {
        logger.debug('Using cached router for config');
        return routerCache.get(configStr);
    }

    try {
        const config = JSON.parse(Buffer.from(configStr, 'base64').toString('utf-8'));
        logger.info('Creating new router with config', {
            username: config.username ? '[REDACTED]' : undefined,
            password: config.password ? '[REDACTED]' : undefined
        });

        const addonWithConfig = addonInterface.setConfiguration(config);
        const router = getRouter(addonWithConfig);
        
        routerCache.set(configStr, router);
        return router;
    } catch (error) {
        logger.error('Error creating router:', error);
        return null;
    }
}

// Root handler
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Configure endpoint
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Handle manifest.json specifically
app.get('/:config/manifest.json', (req, res, next) => {
    logger.info('Manifest request', {
        config: req.params.config ? '[REDACTED]' : undefined
    });

    const router = getOrCreateRouter(req.params.config);
    if (!router) {
        logger.error('Failed to create router for manifest');
        return res.status(500).json({ error: 'Invalid configuration' });
    }

    req.url = '/manifest.json';
    router(req, res, next);
});

// Handle catalog requests
app.get('/:config/catalog/:type/:id/:extra?.json', (req, res, next) => {
    logger.info('Catalog request', {
        type: req.params.type,
        id: req.params.id,
        extra: req.params.extra
    });

    const router = getOrCreateRouter(req.params.config);
    if (!router) {
        logger.error('Failed to create router for catalog');
        return res.status(500).json({ error: 'Invalid configuration' });
    }

    const url = `/catalog/${req.params.type}/${req.params.id}${req.params.extra ? '/' + req.params.extra : ''}.json`;
    req.url = url;
    router(req, res, next);
});

// Handle stream requests
app.get('/:config/stream/:type/:id', (req, res, next) => {
    logger.info('Stream request', {
        type: req.params.type,
        id: req.params.id
    });

    const router = getOrCreateRouter(req.params.config);
    if (!router) {
        logger.error('Failed to create router for stream');
        return res.status(500).json({ error: 'Invalid configuration' });
    }

    req.url = `/stream/${req.params.type}/${req.params.id}`;
    router(req, res, next);
});

// Handle meta requests
app.get('/:config/meta/:type/:id', (req, res, next) => {
    logger.info('Meta request', {
        type: req.params.type,
        id: req.params.id
    });

    const router = getOrCreateRouter(req.params.config);
    if (!router) {
        logger.error('Failed to create router for meta');
        return res.status(500).json({ error: 'Invalid configuration' });
    }

    req.url = `/meta/${req.params.type}/${req.params.id}`;
    router(req, res, next);
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Error handling request:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Not found' });
});

function startServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                logger.warn(`Port ${port} is in use, trying ${port + 1}`);
                resolve(startServer(port + 1));
            } else {
                logger.error('Server error:', error);
                reject(error);
            }
        });

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception:', error);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
        });

        server.listen(port, () => {
            logger.info(`Addon running on http://127.0.0.1:${port}`);
            resolve(server);
        });
    });
}

startServer(9876).catch(err => {
    logger.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = { app, startServer };
