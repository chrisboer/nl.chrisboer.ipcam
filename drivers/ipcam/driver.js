'use strict'

// Require dependencies
var KodiWs = require('node-kodi-ws')
var Fuse = require('fuse.js')
var Utils = require('../../libs/utils')

// Keep track of registered devices
var registeredDevices = []

// Init the logging
console.log = function () {
  // Save log message to settings
  // Retreive current logs
  let currentLogs = Homey.manager('settings').get('currentLogs')
  if (!currentLogs) currentLogs = []

  // Push new event, remove items over 50 and save new array. Use JSON Stringify to make sure objects are logged properly
  let logArguments = Array.from(arguments)
  logArguments.forEach(function (part, index, theArray) {
    theArray[index] = JSON.stringify(part)
  })
  currentLogs.push({datetime: new Date(), message: logArguments.join(' ')})
  if (currentLogs.length > 50) currentLogs.splice(0, 1)
  Homey.manager('settings').set('currentLogs', currentLogs)

  // Output to console as well
  this.apply(console, arguments)
}.bind(console.log)

module.exports.init = function (devices, callback) {
  // Initiate a Kodi instance for each registered device
  devices.forEach(function (device) {
    // Build Xbmc objects
    module.exports.getSettings(device, function (err, settings) {
      if (err) {
        callback(err, null)
      }
      // Try to connect and register device using websockets
      // Try to reconnect every 10sec
      function reconnect () {
        console.log('Trying to reconnect')
        KodiWs(settings.host, settings.tcpport)
          .then(function (connection) {
            // Keep track of device id
            connection.id = settings.host
            connection.tcpport = settings.tcpport
            connection.device_data = device.data
            // Register the device
            registeredDevices.push(connection)
            // Start listening for Kodi events
            startListeningForEvents(connection)
          })
          .catch(function (err) {
            console.log('Stil cannot reconnect: ', err)
            setTimeout(reconnect, 10000)
          })
      }

      reconnect()
    })
  })


  callback()
}

// Pairing functionality
module.exports.pair = function (socket) {
  // Link the configure function to the front end
  socket.on('configure_kodi', function (device, callback) {
    // data contains connections data of kodi
    // Try to connect and register device
    KodiWs(device.settings.host, device.settings.tcpport)
      .then(function (connection) {
        // Keep track of device id
        connection.id = device.settings.host
        connection.tcpport = device.settings.tcpport
        connection.device_data = device.data
        // Register the device
        registeredDevices.push(connection)
        // Start listening for Kodi events
        startListeningForEvents(connection)
        callback(null, __('pair.feedback.succesfully_connected'))
      })
      .catch(function (err) {
        callback(__('pair.feedback.could_not_connect') + ' ' + err)
      })
  })

  socket.on('disconnect', function () {
    // Don't care what happens
  })
}

// Device gets deleted
module.exports.deleted = function (device_data) {
  console.log('Deleting device', device_data.id)
  // Create a new array without the deleted device
  deleteDevice(device_data.id)
}

// A user has updated settings, update the device object
module.exports.settings = function (device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback) {
  console.log('Updating device', device_data.id, 'to', newSettingsObj.host, newSettingsObj.tcpport)
  // If we can connect using the new settings
  KodiWs(newSettingsObj.host, newSettingsObj.tcpport)
    .then(function (connection) {
      // Create a new array without the updated device
      deleteDevice(device_data.id)
      // Keep track of the device id and port
      connection.id = newSettingsObj.host
      connection.tcpport = newSettingsObj.tcpport
      connection.device_data = device_data
      // Register the new settings of device
      registeredDevices.push(connection)
      // Start listening for Kodi events
      startListeningForEvents(connection)
    })
    .then(function () {
      callback(null, __('pair.feedback.succesfully_connected'))
    })
    .catch(function (err) {
      callback(__('pair.feedback.could_not_connect') + ' ' + err)
    })
}

// START EXPORTING DRIVER SPECIFIC FUNCTIONS
// NOTE: No callbacks are defined since this drivers makes use of the Promise API

/* **********************************
  SEARCH MOVIE
************************************/
module.exports.searchMovie = function (deviceSearchParameters, movieTitle) {
  return new Promise(function (resolve, reject) {
    console.log('searchMovie()', deviceSearchParameters, movieTitle)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Kodi API: VideoLibrary.GetMovies
        kodi.run('VideoLibrary.GetMovies', {})
          .then(function (result) {
            if (result.movies) { // Check if there are movies in the media library
              // Parse the result and look for movieTitle
              // Set option for fuzzy search
              var options = {
                caseSensitive: false, // Don't care about case whenever we're searching titles by speech
                includeScore: false, // Don't need the score, the first item has the highest probability
                shouldSort: true, // Should be true, since we want result[0] to be the item with the highest probability
                threshold: 0.4, // 0 = perfect match, 1 = match all..
                location: 0,
                distance: 100,
                maxPatternLength: 64,
                keys: ['label']
              }

              // Create the fuzzy search object
              var fuse = new Fuse(result.movies, options)
              var searchResult = fuse.search(movieTitle.trim())

              // If there's a result
              if (searchResult.length > 0) {
                resolve(searchResult[0]) // Always use searchResult[0], this is the result with the highest probability (setting shouldSort = true)
              } else {
                reject(__('talkback.movie_not_found'))
              }
            } else {
              // No movies in media libary, throw an error
              reject(__('talkback.no_movies_in_library'))
            }
          })
      })
      .catch(reject)
  })
}

/* **********************************
  PLAY MOVIE
************************************/
module.exports.playMovie = function (deviceSearchParameters, movieId) {
  // Kodi API: Player.Open
  return new Promise(function (resolve, reject) {
    console.log('playMovie()', deviceSearchParameters, movieId)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Build the parameter to play a movie
        var param = {
          item: {
            movieid: movieId
          }
        }

        kodi.run('Player.Open', param)
          .then(function () {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

/* **********************************
  PLAY PAUSE
************************************/
module.exports.playPause = function (deviceSearchParameters) {
  // Kodi API: Player.Open
  return new Promise(function (resolve, reject) {
    console.log('playPause()', deviceSearchParameters)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Get the active player so we can pause it
        kodi.run('Player.GetActivePlayers', {})
          .then(function (result) {
            if (result[0]) { // Check whether there is an active player to stop
              // Build request parameters and supply the player
              var param = {
                playerid: result[0].playerid
              }
              kodi.run('Player.PlayPause', param)
                .then(function (result) {
                  var newState = result.speed === 0 ? 'paused' : 'resumed'
                  // Paused succesfully, return the new state and the device that has been paused
                  resolve(newState, kodi)
                })
            }
          })
      })
      .catch(reject)
  })
}

/* **********************************
  STOP
************************************/
module.exports.stop = function (deviceSearchParameters) {
  // Kodi API: Player.Open
  return new Promise(function (resolve, reject) {
    console.log('stop()', deviceSearchParameters)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Get the active player so we can pause it
        kodi.run('Player.GetActivePlayers', {})
          .then(function (result) {
            if (result[0]) { // Check whether there is an active player to stop
              // Build request parameters and supply the player
              var param = {
                playerid: result[0].playerid
              }
              kodi.run('Player.Stop', param)
                .then(function (result) {
                  // Stopped succesfully, return the device that has been stopped
                  resolve(kodi)
                })
            }
          })
      })
      .catch(reject)
  })
}

/* **********************************
  SEARCH MUSIC
************************************/
module.exports.searchMusic = function (deviceSearchParameters, queryProperty, searchQuery) {
  return new Promise(function (resolve, reject) {
    console.log('searchMusic()', deviceSearchParameters, queryProperty, searchQuery)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Determine whether to search by artist or ALBUM
        var searchMethod = ''
        var fuzzyLookupKey = ''
        switch (queryProperty) {
          case 'ARTIST':
            searchMethod = 'AudioLibrary.GetArtists'
            fuzzyLookupKey = 'artist'
            break
          case 'ALBUM':
            searchMethod = 'AudioLibrary.GetAlbums'
            break
        }
        // Call kodi for artist / albums
        kodi.run(searchMethod, {})
          .then(
            function (result) {
              if (result[fuzzyLookupKey + 's']) { // Check if there is music in the library
                // Parse the result and look for artist or album
                // Set option for fuzzy search
                var options = {
                  caseSensitive: false, // Don't care about case whenever we're searching titles by speech
                  includeScore: false, // Don't need the score, the first item has the highest probability
                  shouldSort: true, // Should be true, since we want result[0] to be the item with the highest probability
                  threshold: 0.4, // 0 = perfect match, 1 = match all..
                  location: 0,
                  distance: 100,
                  maxPatternLength: 64,
                  keys: [fuzzyLookupKey] // Set to either 'artist' or 'album'
                }

                // Create the fuzzy search object
                var fuse = new Fuse(result[fuzzyLookupKey + 's'], options) // + 's' since the root tag is always plural (artistS and albumS)
                var searchResult = fuse.search(searchQuery.trim())

                // If there's a result
                if (searchResult.length > 0) {
                  var artistOrAlbum = searchResult[0] // Always use searchResult[0], this is the result with the highest probability (setting shouldSort = true)

                  // Build parameter filter to obtain filtered songs
                  var params = { filter: {} }
                  params.filter[fuzzyLookupKey + 'id'] = artistOrAlbum.artistid

                  // Call Kodi for songs by artist/albums
                  kodi.run('AudioLibrary.GetSongs', params)
                    .then(function (result) {
                      // Return the array of songs
                      resolve(result.songs)
                    })
                } else {
                  // Artist/Album not found
                  switch (queryProperty) {
                    case 'ARTIST':
                      reject(__('talkback.artist_not_found'))
                      break
                    case 'ALBUM':
                      reject(__('talkback.album_not_found'))
                      break
                  }
                }
              } else {
                // No music in library
                reject(__('talkback.no_music_in_library'))
              }
            }
        )
      })
      .catch(reject)
  })
}

/* **********************************
  PLAY MUSIC
************************************/
/*
  - Clears playlist
  - Adds songs
  - Starts playing
*/
module.exports.playMusic = function (deviceSearchParameters, songsToPlay, shuffle) {
  return new Promise(function (resolve, reject) {
    console.log('playMusic()', deviceSearchParameters, songsToPlay)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Clear the playlist
        var params = {
          playlistid: 0
        }
        kodi.run('Playlist.Clear', params)
          .then(function () {
            // Create an array of songids
            var songs = songsToPlay.map(function (item) {
              return {songid: item.songid}
            })

            // Shuffle the array
            if (shuffle) {
              songs = Utils.shuffle(songs)
            }

            var params = {
              playlistid: 0,
              item: songs
            }
            // Add the songs to the playlist
            kodi.run('Playlist.Add', params)
              .then(function (result) {
                // Play the playlist
                var params = {
                  item: {
                    playlistid: 0
                  },
                  options: {
                    repeat: 'all'
                  }
                }

                kodi.run('Player.Open', params)
                  .then(function (result) {
                    // Succesfully played the playlist, return the device for flow handling
                    resolve(kodi)
                  })
              })
          })
      })
  })
}

/* **********************************
  NEXT / PREVIOUS TRACK
************************************/
module.exports.nextOrPreviousTrack = function (deviceSearchParameters, previousOrNext) {
  return new Promise(function (resolve, reject) {
    console.log('nextOrPreviousTrack()', deviceSearchParameters, previousOrNext)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Get the active player so we can next/previous it
        kodi.run('Player.GetActivePlayers', {})
          .then(function (result) {
            if (result[0]) { // Check whether there is an active player to stop
              // Build request parameters and supply the player
              var params = {
                playerid: result[0].playerid,
                to: previousOrNext
              }

              kodi.run('Player.GoTo', params)
                .then(function (result) {
                  resolve(previousOrNext)
                })
            }
          })
      })
  })
}

/* **********************************
  SEARCH LATEST EPISODE
************************************/
module.exports.getLatestEpisode = function (deviceSearchParameters, seriesName) {
  return new Promise(function (resolve, reject) {
    console.log('getLatestEpisode()', deviceSearchParameters, seriesName)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Get all the series and fuzzy search for the one we need
        kodi.run('VideoLibrary.GetTVShows', {})
          .then(function (result) {
            if (result.tvshows) { // Check whether there are TV shows in the library
              // Parse the result and look for movieTitle
              // Set option for fuzzy search
              var options = {
                caseSensitive: false, // Don't care about case whenever we're searching titles by speech
                includeScore: false, // Don't need the score, the first item has the highest probability
                shouldSort: true, // Should be true, since we want result[0] to be the item with the highest probability
                threshold: 0.4, // 0 = perfect match, 1 = match all..
                location: 0,
                distance: 100,
                maxPatternLength: 64,
                keys: ['label']
              }

              // Create the fuzzy search object
              var fuse = new Fuse(result.tvshows, options)
              var searchResult = fuse.search(seriesName.trim())

              // If there's a result
              if (searchResult.length > 0) {
                // e.g. { label: 'Narcos', tvshowid: 43 }
                var seriesResult = searchResult[0] // Always use searchResult[0], this is the result with the highest probability (setting shouldSort = true)

                // Build filter to search unwatched episodes
                var param = {
                  tvshowid: seriesResult.tvshowid,
                  properties: ['playcount', 'showtitle', 'season', 'episode'],
                  // Sort the result so we can grab the first unwatched episode
                  sort: {
                    order: 'ascending',
                    method: 'episode',
                    ignorearticle: true
                  }
                }
                kodi.run('VideoLibrary.GetEpisodes', param)
                  .then(function (result) {
                    // Check if there are episodes for this TV show
                    if (result.episodes) {
                      // Check whether we have seen this episode already
                      var firstUnplayedEpisode = result.episodes.filter(function (item) {
                        return item.playcount === 0
                      })
                      if (firstUnplayedEpisode.length > 0) {
                        resolve(firstUnplayedEpisode[0]) // Resolve the first unplayed episode
                      } else {
                        reject(__('talkback.no_latest_episode_found'))
                      }
                    } else {
                      reject(__('talkback.no_latest_episode_found'))
                    }
                  })
              } else {
                reject(__('talkback.series_not_found'))
              }
            } else {
              // No TV Shows in the library
              reject(__('talkback.no_tvshows_in_library'))
            }
          })
      })
  })
}

/* **********************************
  PLAY EPISODE
************************************/
module.exports.playEpisode = function (deviceSearchParameters, episode) {
  // Kodi API: Player.Open
  return new Promise(function (resolve, reject) {
    console.log('playEpisode()', deviceSearchParameters, episode)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Build the parameter to play a movie
        var param = {
          item: {
            episodeid: episode.episodeid
          }
        }

        kodi.run('Player.Open', param)
          .then(function (result) {
            // Episode started playing succesfully, return device for flow handling
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

/* **********************************
  SEARCH ADDON
************************************/
module.exports.searchAddon = function (deviceSearchParameters, addonName) {
  return new Promise(function (resolve, reject) {
    console.log('searchAddon()', deviceSearchParameters, addonName)

    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        var params = {
          properties: ['name']
        }
        // Get all the addons and fuzzy search for the one we need
        kodi.run('Addons.GetAddons', params)
          .then(function (result) {
            if (result.addons) { // Check whether there are TV shows in the library
              // Parse the result and look for movieTitle
              // Set option for fuzzy search
              var options = {
                caseSensitive: false, // Don't care about case whenever we're searching titles by speech
                includeScore: false, // Don't need the score, the first item has the highest probability
                shouldSort: true, // Should be true, since we want result[0] to be the item with the highest probability
                threshold: 0.4, // 0 = perfect match, 1 = match all..
                location: 0,
                distance: 100,
                maxPatternLength: 64,
                keys: ['name']
              }

              // Create the fuzzy search object
              var fuse = new Fuse(result.addons, options)
              var addonNameResult = fuse.search(addonName.trim())

              // If there's a result
              if (addonNameResult.length > 0) {
                resolve(addonNameResult[0]) // Always use searchResult[0], this is the result with the highest probability (setting shouldSort = true)
              } else {
                reject(__('talkback.addon_not_found'))
              }
              console.log(addonNameResult)
            } else {
              // No TV Shows in the library
              reject(__('talkback.no_addons_installed'))
            }
          })
      })
  })
}

/* **********************************
  START ADDON
************************************/
module.exports.startAddon = function (deviceSearchParameters, addonId) {
  // Kodi API: Addons.ExecuteAddon
  return new Promise(function (resolve, reject) {
    console.log('startAddon()', deviceSearchParameters, addonId)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        // Build the parameter to start the addon
        var param = {
          addonid: addonId
        }

        kodi.run('Addons.ExecuteAddon', param)
          .then(function (result) {
            console.log('result', result)
            resolve(kodi)
          })
          .catch(function (err) {
            console.log('err', err)
          })
      })
      .catch(reject)
  })
}

/* **********************************
  GET LATEST MOVIES
************************************/
module.exports.getNewestMovies = function (deviceSearchParameters, daysSince) {
  return new Promise(function (resolve, reject) {
    console.log('getNewestMovies()', deviceSearchParameters, daysSince)
    // Calculate cutoff date to check for new movies
    let dateSince = new Date()
    dateSince.setDate(dateSince.getDate() - daysSince)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        let params = {
          filter: {
            operator: 'greaterthan',
            field: 'dateadded',
            value: dateSince.toISOString().substring(0, 10)
          }
        }

        // Kodi API: VideoLibrary.GetMovies
        kodi.run('VideoLibrary.GetMovies', params)
          .then(function (result) {
            console.log(result)
            if (result.movies) { // Check if there are movies in the media library
              resolve(result.movies)
            } else {
              // No movies in media libary, throw an error
              reject(__('talkback.no_new_movies_in_library'))
            }
          })
      })
      .catch(reject)
  })
}

/* **********************************
  GET LATEST EPISODES
************************************/
module.exports.getNewestEpisodes = function (deviceSearchParameters, daysSince) {
  return new Promise(function (resolve, reject) {
    console.log('getNewestEpisodes()', deviceSearchParameters, daysSince)
    // Calculate cutoff date to check for new Episodes
    let dateSince = new Date()
    dateSince.setDate(dateSince.getDate() - daysSince)
    // search Kodi instance by deviceSearchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        let params = {
          filter: {
            operator: 'greaterthan',
            field: 'dateadded',
            value: dateSince.toISOString().substring(0, 10)
          },
          properties: ['playcount', 'showtitle', 'season', 'episode', 'title']
        }

        // Kodi API: VideoLibrary.GetEpisodes
        kodi.run('VideoLibrary.GetEpisodes', params)
          .then(function (result) {
            console.log(result)
            if (result.episodes) { // Check if there are episodes in the media library
              resolve(result.episodes)
            } else {
              // No new episodes in media libary, throw an error
              reject(__('talkback.no_new_episodes_in_library'))
            }
          })
      })
      .catch(reject)
  })
}

/* **********************************
  SYSTEM FUNCTIONS
************************************/
module.exports.shutdownKodi = function (deviceSearchParameters) {
  // Kodi API: System.Shutdown
  return new Promise(function (resolve, reject) {
    console.log('shutdownKodi()', deviceSearchParameters)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        kodi.run('System.Shutdown')
          .then(function (result) {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

module.exports.rebootKodi = function (deviceSearchParameters) {
  // Kodi API: System.Reboot
  return new Promise(function (resolve, reject) {
    console.log('rebootKodi()', deviceSearchParameters)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        kodi.run('System.Reboot')
          .then(function (result) {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

module.exports.hibernateKodi = function (deviceSearchParameters) {
  // Kodi API: System.Hibernate
  return new Promise(function (resolve, reject) {
    console.log('hibernateKodi()', deviceSearchParameters)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        kodi.run('System.Hibernate')
          .then(function (result) {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

module.exports.muteKodi = function (deviceSearchParameters) {
  // Kodi API: System.Hibernate
  return new Promise(function (resolve, reject) {
    console.log('muteKodi()', deviceSearchParameters)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        kodi.run('Application.SetMute', true)
          .then(function (result) {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}

module.exports.unmuteKodi = function (deviceSearchParameters) {
  // Kodi API: System.Hibernate
  return new Promise(function (resolve, reject) {
    console.log('muteKodi()', deviceSearchParameters)
    // search Kodi instance by searchParameters
    getKodiInstance(deviceSearchParameters)
      .then(function (kodi) {
        kodi.run('Application.SetMute', false)
          .then(function (result) {
            resolve(kodi)
          })
      })
      .catch(reject)
  })
}
/* **********************************
  GENERIC FUNCTIONS
************************************/
function deleteDevice (deviceId) {
  registeredDevices = registeredDevices.filter(function (item) {
    return item.id !== deviceId
  })
}

// Return the Kodi device specified by the search parameters
function getKodiInstance (searchParameters) {
  return new Promise(function (resolve, reject) {
    console.log('getKodiInstance', searchParameters)
    // If only 1 registered device, just return it
    var device = null
    if (registeredDevices.length === 1 || searchParameters === null) {
      device = registeredDevices[0]
    } else {
      // Search parameters have been provided, look for a device with the supplied ID
      registeredDevices.filter(function (item) {
        return item.id === searchParameters
      })
    }

    if (device) {
      resolve(device)
    } else {
      reject(__('talkback.device_not_found'))
    }
  })
}

/* **********************************
  KODI EVENT LISTENERS
    - All functions related to event handling
************************************/
function startListeningForEvents (device) {
  console.log('startListeningForEvents()')
  // Map supported Kodi events to indidual functions and pass the device connection to trigger the appropriate flows
  device.notification('Player.OnPause', function (result) { onKodiGenericEvent(result, device, 'kodi_pause') })
  device.notification('Player.OnPlay', function (result) { onKodiPlay(result, device) })
  device.notification('Player.OnStop', function (result) { onKodiStop(result, device, 'kodi_stop') })
  device.notification('System.OnQuit', function (result) { onKodiGenericEvent(result, device, 'kodi_shutdown') })
  device.notification('System.OnSleep', function (result) { onKodiGenericEvent(result, device, 'kodi_hibernate') })
  device.notification('System.OnRestart', function (result) { onKodiGenericEvent(result, device, 'kodi_reboot') })
  device.notification('System.OnWake', function (result) { onKodiGenericEvent(result, device, 'kodi_wake') })

  // Catch error when Kodi suddenly goes offline to prevent the app from crashing
  device.on('error', function (error) {
    console.log('Kodi connection error: ', error)
  })

  // Keep track of connection loss
  device.on('close', function () {
    console.log('Connection closed')
    // Save connection details to reconnect
    let host = device.id
    let tcpport = device.tcpport
    // Delete the device details from Homey
    deleteDevice(device.id)

    // Try to reconnect every 10sec
    function reconnect () {
      console.log('Trying to reconnect')
      KodiWs(host, tcpport)
        .then(function (connection) {
          // Keep track of device id
          connection.id = host
          connection.tcpport = tcpport
          connection.device_data = device.data
          // Register the device
          registeredDevices.push(connection)
          // Start listening for Kodi events
          startListeningForEvents(connection)
        })
        .catch(function (err) {
          console.log('Stil cannot reconnect: ', err)
          setTimeout(reconnect, 10000)
        })
    }

    reconnect()
  })
}

function onKodiGenericEvent (result, device, triggerName) {
  console.log('onKodiGenericEvent() ', triggerName)
  console.log(result)
  // Trigger the flow
  console.log('Triggering flow ', triggerName)
  Homey.manager('flow').triggerDevice(triggerName, null, null, device.device_data)
}

function onKodiStop (result, device) {
  console.log('onKodiStop')
  console.log('Triggering flow ', 'kodi_stop')
  Homey.manager('flow').triggerDevice('kodi_stop', null, null, device.device_data)
  // Check if the user stopped a movie/episode halfway or whether the episode/movie actually ended
  if (result.data.end === true) {
    if (result.data.item.type === 'episode' || result.data.item.type === 'episodes') {
      // Episode ended
      // Get Episode details
      var episodeParams = {
        episodeid: result.data.item.id,
        properties: ['showtitle', 'season', 'episode', 'title']
      }
      device.run('VideoLibrary.GetEpisodeDetails', episodeParams)
        .then(function (episodeResult) {
          // Trigger action kodi_episode_start
          Homey.log('Triggering flow kodi_episode_stop, tvshow_title: ', episodeResult.episodedetails.showtitle, 'episode_title: ', episodeResult.episodedetails.label, 'season: ', episodeResult.episodedetails.season, 'episode: ', episodeResult.episodedetails.episode)
          Homey.manager('flow').triggerDevice('kodi_episode_stop', {
            tvshow_title: episodeResult.episodedetails.showtitle,
            episode_title: episodeResult.episodedetails.label,
            season: episodeResult.episodedetails.season,
            episode: episodeResult.episodedetails.episode
          }, null, device.device_data)
        })
    } else {
      // A movie ended
      var movieParams = {
        movieid: result.data.item.id,
        properties: ['title']
      }
      // Else get the title by id
      device.run('VideoLibrary.GetMovieDetails', movieParams)
        .then(function (movieResult) {
          // Trigger appropriate flows
          Homey.log('Triggering flow kodi_movie_stop, movie_title: ', movieResult.moviedetails.label, 'device: ', device.device_data)
          // Trigger flows and pass variables
          Homey.manager('flow').triggerDevice('kodi_movie_stop', {
            // Pass movie title as flow token
            movie_title: movieResult.moviedetails.label
          }, null, device.device_data)
        })
    }
  }
}

function onKodiPlay (result, device) {
  console.log('onKodiPlay()')
  // Throw a 'anything started playing' event
  console.log('Triggering flow kodi_playing_something')
  Homey.manager('flow').triggerDevice('kodi_playing_something', null, null, device.device_data)

  // Check if there's a new song/movie/episode playback or a resume action (player % > 1)
  // Build request parameters and supply the player
  var params = {
    playerid: result.data.player.playerid === -1 ? 1 : result.data.player.playerid, // Convert -1 to 1 if player is an Addon (Exodus / Specto)
    properties: ['percentage']
  }
  device.run('Player.GetProperties', params)
    .then(function (playerResult) {
      // If the percentage is above 0.1, we have a resume-action
      if (playerResult) {
        if (playerResult.percentage >= 0.1) {
          console.log('Triggering flow kodi_resume')
          Homey.manager('flow').triggerDevice('kodi_resume', null, null, device.device_data)
        // Check the playback type (movie or episode)
        } else if (result.data.item.type === 'movie' || result.data.item.type === 'movies') {
          // Check if we get a title from Kodi
          if (result.data.item.title) {
            console.log('Triggering flow kodi_movie_start for device', device.id)
            Homey.manager('flow').triggerDevice('kodi_movie_start', {
              // Pass movie title as flow token
              movie_title: result.data.item.title
            }, null, device.device_data)
          } else {
            var movieParams = {
              movieid: result.data.item.id,
              properties: ['title']
            }
            // Else get the title by id
            device.run('VideoLibrary.GetMovieDetails', movieParams)
              .then(function (movieResult) {
                // Trigger appropriate flows
                Homey.log('Triggering flow kodi_movie_start, movie_title: ', movieResult.moviedetails.label, 'device: ', device.device_data)
                // Trigger flows and pass variables
                Homey.manager('flow').triggerDevice('kodi_movie_start', {
                  // Pass movie title as flow token
                  movie_title: movieResult.moviedetails.label
                }, null, device.device_data)
              })
          }
        } else if (result.data.item.type === 'episode' || result.data.item.type === 'episodes') {
          // Get Episode details
          var episodeParams = {
            episodeid: result.data.item.id,
            properties: ['showtitle', 'season', 'episode', 'title']
          }
          device.run('VideoLibrary.GetEpisodeDetails', episodeParams)
            .then(function (episodeResult) {
              // Trigger action kodi_episode_start
              Homey.log('Triggering flow kodi_episode_start, tvshow_title: ', episodeResult.episodedetails.showtitle, 'episode_title: ', episodeResult.episodedetails.label, 'season: ', episodeResult.episodedetails.season, 'episode: ', episodeResult.episodedetails.episode)
              Homey.manager('flow').triggerDevice('kodi_episode_start', {
                tvshow_title: episodeResult.episodedetails.showtitle,
                episode_title: episodeResult.episodedetails.label,
                season: episodeResult.episodedetails.season,
                episode: episodeResult.episodedetails.episode
              }, null, device.device_data)
            })
        }
      }
    })
}
