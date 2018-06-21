const facebook = require("facebook-chat-api")
const repl = require("repl")

const helpers = require("./util/helpers.js")
const getCommandHandler = require("./commands/command-handlers").getCommandHandler
const eventHandlers = require("./event-handlers")
const log = require("./util/log")

/**
 * Creates a singleton that represents a Messer session.
 * @class
 */
function Messer(options = {}) {
  this.api = null
  this.user = null

  this.threadCache = {} // cached by id
  this.threadNameToIdMap = {} // maps a thread name to a thread id

  this.lastThread = null
  this.debug = options.debug || false
}

/**
 * Perform inital load of, or refresh, user info.
 */
Messer.prototype.getOrRefreshUserInfo = function getOrRefreshUserInfo() {
  return new Promise((resolve, reject) => {
    const userId = this.api.getCurrentUserID()
    if (this.user === null) this.user = {}

    return this.api.getUserInfo(userId, (err, data) => {
      if (err) return reject(err)

      Object.assign(this.user, data[userId])
      this.user.userID = userId // set userId, because the api doesn't

      return resolve(this.user)
    })
  })
}

/**
 * Refresh user's friends list
 */
Messer.prototype.refreshFriendsList = function refreshFriendsList() {
  return new Promise((resolve, reject) =>
    this.api.getFriendsList((err, data) => {
      if (err) return reject(err)

      this.user.friendsList = {}

      // store friends by name
      data.forEach((friend) => {
        this.user.friendsList[friend.fullName] = friend
      })

      return resolve(this.user)
    })
  )
}

/**
 * Refresh the thread list.
 */
Messer.prototype.refreshThreadList = function refreshThreadList() {
  return new Promise((resolve, reject) =>
    this.api.getThreadList(20, null, ["INBOX"], (err, threads) => {
      if (!threads) return reject("Nothing returned from getThreadList")

      threads.forEach(thread => this.cacheThread(thread))
      return resolve()
    }))
}

Messer.prototype.fetchUser = function fetchUser() {
  return Promise.all([
    this.getOrRefreshUserInfo(),
    this.refreshFriendsList(),
    this.refreshThreadList(),
  ])
}

/**
 * Authenticates a user with Facebook. Prompts for credentials if argument is undefined.
 * @param {Object} credentials - The Facebook credentials of the user
 * @param {string} email - The user's Facebook email
 * @param {string} credentials.password - The user's Facebook password
 * @return {Promise<null>}
 */
Messer.prototype.authenticate = function authenticate(credentials) {
  log("Logging in...")

  const config = {
    forceLogin: true,
    logLevel: this.debug ? "info" : "silent",
    selfListen: true,
    listenEvents: true,
  }

  return new Promise((resolve, reject) => {
    facebook(credentials, config, (err, fbApi) => {
      if (err) {
        switch (err.error) {
          case "login-approval":
            helpers.promptCode().then(code => err.continue(code))
            break
          default:
            return reject(`Failed to login as [${credentials.email}] - ${err.error}`)
        }
        return null
      }

      helpers.saveAppState(fbApi.getAppState())

      this.api = fbApi

      return resolve()
    })
  })
}

/**
 * Starts a Messer session.
 */
Messer.prototype.start = function start() {
  helpers.getCredentials()
    .then(credentials => this.authenticate(credentials))
    .then(() => this.getOrRefreshUserInfo())
    .then(() => this.fetchUser())
    .then(() => {
      log(`Successfully logged in as ${this.user.name}`)

      this.api.listen((err, ev) => {
        if (err) return null

        return eventHandlers[ev.type].call(this, ev)
      })

      repl.start({
        ignoreUndefined: true,
        eval: (input, context, filename, cb) => this.processCommand(input)
          .then((res) => { log(res); cb(null) })
          .catch((err) => { log(err); cb(null) }),
      })
    })
    .catch(err => log(err))
}

/**
 * Execute appropriate action for user input commands.
 * @param {String} rawCommand - command to proces
 * @return {Promise}
 */
Messer.prototype.processCommand = function processCommand(rawCommand) {
  // ignore if rawCommand is only spaces
  if (rawCommand.trim().length === 0) return null

  const args = rawCommand.replace("\n", "").split(" ")
  const commandHandler = getCommandHandler(args[0])

  if (!commandHandler) {
    return log("Invalid command - check your syntax")
  }

  return commandHandler.call(this, rawCommand)
}

/**
 * Adds a thread node to the thread cache.
 * @param {Object} thread - thread object to cache
 */
Messer.prototype.cacheThread = function cacheThread(thread) {
  this.threadCache[thread.threadID] = {
    name: thread.name,
    threadID: thread.threadID,
    color: thread.color,
    lastMessageTimestamp: thread.lastMessageTimestamp,
    unreadCount: thread.unreadCount,
  } // only cache the info we need

  if (thread.name) {
    this.threadNameToIdMap[thread.name] = thread.threadID
  }
}

/**
 * Gets thread by thread name. Will select the thread with name starting with the given name.
 * @param {String} _threadName
 */
Messer.prototype.getThreadByName = function getThreadByName(threadName) {
  return new Promise((resolve, reject) => {
    const fullThreadName = Object.keys(this.threadNameToIdMap)
      .find(n => n.toLowerCase().startsWith(threadName.toLowerCase()))

    const threadID = this.threadNameToIdMap[fullThreadName]

    // if thread not cached, try the friends list
    if (!threadID) {
      const friendName = Object.keys(this.user.friendsList)
        .find(n => n.toLowerCase().startsWith(threadName.toLowerCase()))

      if (!friendName) {
        return reject("No threadID could be found.")
      }

      // create a fake thread based off friend info
      const friendThread = {
        name: friendName,
        threadID: this.user.friendsList[friendName].userID,
      }

      return resolve(friendThread)
    }

    return this.getThreadById(threadID)
      .then((thread) => {
        if (!thread.name) {
          Object.assign(thread, { name: threadName })
        }

        return resolve(thread)
      })
      .catch(err => reject(err))
  })
}

/**
 * Gets thread by threadID.
 * @param {String} threadID - threadID of desired thread
 * @param {Boolean} requireName - specifies if the thread name is absolutely necessary
 */
Messer.prototype.getThreadById = function getThreadById(threadID, requireName = false) {
  return new Promise((resolve, reject) => {
    let thread = this.threadCache[threadID]

    if (thread) return resolve(thread)

    return this.api.getThreadInfo(threadID, (err, data) => {
      if (err) return reject(err)
      thread = data

      // try to get thread name from friends list
      if (!thread.name && requireName) {
        const friend = helpers.objectValues(this.user.friendsList)
          .find(user => user.userID === threadID)

        thread.name = friend.fullName
      }

      this.cacheThread(thread)

      return resolve(thread)
    })
  })
}

module.exports = Messer
