"use strict";

const { Context } = require("moleculer");
const ConfigLoader = require("config-mixin");
const { MoleculerClientError } = require("moleculer").Errors;

const { FtpSrv, FileSystem } = require('../lib');

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
    const event = FTP_EVENTS[i];
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
        /**
         * list open connections
         * 
         * @actions
         * 
         * @returns {Promise} - list of open connections
         */
        listOpenConnections: {
            rest: {
                method: 'GET',
                path: '/connections'
            },
            permissions: ['ftp.server.connections.list'],
            async handler(ctx) {
                const params = Object.assign({}, ctx.params);
                // get connections
                const connections = this.server.connections;// connections is a object

                return Object.keys(connections).map((key) => {
                    const connection = connections[key];
                    return {
                        ip: connection.ip,
                        remoteAddress: connection.commandSocket.remoteAddress,
                        user: connection.user,
                    }
                });
            }
        },
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
            const resolverFunction = (address) => {
                console.log(address)
                return "127.0.0.1";
            }
            const ftpConfig = {
                url: this.config['ftp.url'],
                pasv_url: resolverFunction,
                log: this.logger,
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


            ftpServer.listen(() => {
                this.logger.info(`FTP server listening on ${ftpConfig.url}`);
            });

            ftpServer.on('close', () => {
                this.logger.info(`FTP server closed`);
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
                    resolve();
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

                    // get user blacklist and whitelist
                    const blacklist = await this.getUserBlacklist(user);
                    const whitelist = await this.getUserWhitelist(user);

                    // create fs driver
                    const fileSystem = await this.createFsDriver(connection, user);

                    // resolve
                    resolve({
                        fs: fileSystem,
                        blacklist,
                        // whitelist,
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
                console.log(event)
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
        async createFsDriver(connection, _user) {
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
            this.logger.info(`Creating local fs driver for ${user.username} for path ${user.homedir}`);
            const fs = new FileSystem(connection, {
                root: user.homedir
            });
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
            }).map((permission) => {
                return permission.substring(1);
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
        return this.createFTPServer();
    },

    /**
     * Service stopped lifecycle event handler
     */
    stopped() {
        return this.stopFTPServer();
    }

}



