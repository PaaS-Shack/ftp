"use strict";

const { Context } = require("moleculer");
const ConfigLoader = require("config-mixin");
const { MoleculerClientError } = require("moleculer").Errors;

const { FtpSrv } = require('ftp-srv');

const { LocalFileSystem } = require('../fs/local');


const FTP_EVENTS = [
    'STOR',
    'RETR',
    'RNFR',
    'RNTO',
    'DELE',
    'MKD',
    'RMD',
    'CWD',
    'PWD',
    'LIST',
    'NLST',
    'APPE',
    'SIZE',
    'STAT',
    'REST',
    'ABOR',
    'QUIT',
    'SYST',
    'TYPE',
    'PORT',
    'PASV',
    'FEAT',
    'OPTS',
    'NOOP',
    'ALLO',
    'USER',
    'PASS',
    'ACCT',
];

// blacklist of ftp commands
const eventLenth = FTP_EVENTS.length;
for (let i = 0; i < eventLenth; i++) {
    FTP_EVENTS.push(`!${event}`)
}

/**
 * FTP server agent service
 * This service pulls user accounts from v1.ftp.accounts service
 * 
 */

module.exports = {
    // name of service
    name: "ftp.server",
    // version of service
    version: 1,

    /**
     * Service Mixins
     * 
     * @type {Array}
     * @property {ConfigLoader} ConfigLoader - Config loader mixin
     */
    mixins: [
        ConfigLoader(['ftp.**']),
    ],

    /**
     * Service dependencies
     */
    dependencies: [],

    /**
     * Service settings
     * 
     * @type {Object}
     */
    settings: {

        config: {
            'ftp.url': 'ftp://localhost:21',
            'ftp.pasv_url': 'ftp://localhost:30000',
            'ftp.pasv_min': 30000,
            'ftp.pasv_max': 30009,
            'ftp.greeting': 'Welcome to FTP server',
            'ftp.anonymous': false,

        }
    },

    /**
     * service actions
     */
    actions: {

    },

    /**
     * service events
     */
    events: {

    },

    /**
     * service methods
     */
    methods: {
        /**
         * Create FTP server
         * 
         * @returns {Promise}
         */
        async createFTPServer() {

            const ftpConfig = {
                url: this.config['ftp.url'],
                pasv_url: this.config['ftp.pasv_url'],
                pasv_min: this.config['ftp.pasv_min'],
                pasv_max: this.config['ftp.pasv_max'],
                greeting: this.config['ftp.greeting'],
                anonymous: this.config['ftp.anonymous'],
            };

            const ftpServer = new FtpSrv(ftpConfig);

            this.server = ftpServer;

            ftpServer.on('login', async ({ connection, username, password }, resolve, reject) => {
                await this.handleLogin(connection, username, password, resolve, reject);
            });

            ftpServer.on('client-error', ({ context, error }) => {
                this.logger.error('client-error', context, error);
            });

            ftpServer.on('error', (error) => {
                this.logger.error('error', error);
            });

            ftpServer.on('connection', (connection) => {
                this.handleConnection(connection);
            });



        },

        /**
         * Stop FTP server
         * 
         * @returns {Promise}
         */
        stopFTPServer() {
            return new Promise((resolve, reject) => {
                if (this.server) {
                    this.server.close((error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    resolve();
                }
            });
        },

        /**
         * Handle FTP login
         * 
         * @param {Object} connection - FTP connection
         * @param {String} username - FTP username
         * @param {String} password - FTP password
         * @param {Function} resolve - Promise resolve function
         * @param {Function} reject - Promise reject function
         * 
         * @returns {Promise}
         */
        async handleLogin(connection, username, password, resolve, reject) {

            // login user
            await this.broker.call('v1.ftp.accounts.login', { username, password })
                .then(async (user) => {
                    // set user
                    connection.user = user;

                    const blacklist = await this.getUserBlacklist(user);
                    const whitelist = await this.getUserWhitelist(user);

                    const fileSystem = await this.createFsDriver(connection, user);

                    // resolve
                    resolve({
                        user,
                        connection,
                        fs: fileSystem,
                        blacklist,
                        whitelist,
                    });
                }).catch((error) => {
                    // reject
                    reject(error);
                });

        },

        /**
         * Handle FTP connection
         * 
         * @param {Object} connection - FTP connection
         * 
         * @returns {Promise}
         */
        async handleConnection(connection) {
            // create context for connection
            const ctx = Context.create(this.broker, null, { connection });
            // set context
            connection.ctx = ctx;

            this.logger.info(`FTP connection from ${connection.ip} (${connection.socket.remoteAddress})`)

            await this.attachFTPConnectionEvents(connection);
        },

        /**
         * Attach FTP connection events
         * 
         * @param {Object} connection - FTP connection
         * 
         * @returns {Promise} - FTP connection
         */
        async attachFTPConnectionEvents(connection) {
            // log FTP events
            const logFunction = (cmd) => {
                return async (error, filePath) => {
                    this.logger.info(`FTP user ${connection.user?.username} ${cmd} ${filePath}`);
                }
            }
            for (const event of FTP_EVENTS) {
                if (event.startsWith('!')) {
                    // skip blacklisted events
                    continue;
                }
                // attach events
                connection.on(event, logFunction(event));
            }

        },


        /**
         * Create fs driver object
         * 
         * @param {Object} connection - FTP connection
         * @param {Object} user - FTP user
         * 
         * @returns {Promise} fs driver object
         */
        async createFsDriver(connection, user) {
            // get user
            const user = connection.user;

            if (user.driver == 'local') {
                // create local driver
                return await this.createLocalFsDriver(connection, user);
            } else if (user.driver == 's3') {
                // not implemented
                throw new Error('S3 driver not implemented');
            } else if (user.driver == 'git') {
                // not implemented
                throw new Error('git driver not implemented');
            } else {
                // create local driver
                return await this.createLocalFsDriver(connection, user);
            }
        },

        /**
         * Create local fs driver object
         * 
         * @param {Object} connection - FTP connection
         * @param {Object} user - FTP user
         * 
         * @returns {Promise} fs driver object
         */
        async createLocalFsDriver(connection, user) {
            // create local driver
            const fs = new LocalFileSystem(connection, user);
            // return new driver
            return fs;
        },

        /**
         * Get user blacklist
         * 
         * @param {Object} user - FTP user
         * 
         * @returns {Promise} - user blacklist
         */
        async getUserBlacklist(user) {
            // filter user blacklist from user.permissions
            return user.permissions.filter((permission) => {
                return permission.startsWith('!');
            });
        },

        /**
         * Get user whitelist
         * 
         * @param {Object} user - FTP user
         * 
         * @returns {Promise} - user whitelist
         */
        async getUserWhitelist(user) {
            // filter user whitelist from user.permissions
            return user.permissions.filter((permission) => {
                return !permission.startsWith('!');
            })
        },
    },

    /**
     * Service created lifecycle event handler
     */
    created() { },

    /**
     * Service started lifecycle event handler
     */
    started() {

    },

    /**
     * Service stopped lifecycle event handler
     */
    stopped() { }

}



