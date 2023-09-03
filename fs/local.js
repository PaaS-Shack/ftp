const { FtpSrv, FileSystem } = require('ftp-srv');

class LocalFileSystem extends FileSystem {
    constructor(connection, user) {
        super(...arguments);
        this.user = user;
    }
    currentDirectory() {
        return super.currentDirectory(...arguments)
    }

    get(fileName) {
        return super.get(...arguments)
    }

    list(path = '.') {
        return super.list(...arguments)
    }

    chdir(path = '.') {
        return super.chdir(...arguments)
    }

    write(fileName, { append = false, start = undefined } = {}) {
        return super.write(...arguments)
    }

    read(fileName, { start = undefined } = {}) {
        return super.read(...arguments)
    }

    delete(path) {
        return super.delete(...arguments)
    }

    mkdir(path) {
        return super.mkdir(...arguments)
    }

    rename(from, to) {
        return super.rename(...arguments)
    }

    chmod(path, mode) {
        return super.chmod(...arguments)
    }

    getUniqueName() {
        return super.getUniqueName(...arguments)
    }
}

module.exports = {
    LocalFileSystem
}

