const CircularBuffer = require('circular-buffer');
const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');
const Log = require('./Log');
const stateToEntry = require('./format');
const { processTriggers, processHourly, isUnderWay } = require('./triggers');
const openAPI = require('../schema/openapi.json');

// Voyage state tracking
let voyageState = { active: false };
let voyageStatePath = null;

async function loadVoyageState(dataDir) {
  voyageStatePath = join(dataDir, 'voyage-state.json');
  try {
    const data = await readFile(voyageStatePath, 'utf-8');
    voyageState = JSON.parse(data);
    if (voyageState.startTime) {
      voyageState.startTime = new Date(voyageState.startTime);
    }
    if (voyageState.lastDailyTime) {
      voyageState.lastDailyTime = new Date(voyageState.lastDailyTime);
    }
  } catch (e) {
    voyageState = { active: false };
  }
}

async function saveVoyageState() {
  if (!voyageStatePath) return;
  try {
    await writeFile(voyageStatePath, JSON.stringify(voyageState, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save voyage state:', e);
  }
}

function parseJwt(token) {
  if (!token) {
    return {};
  }
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

function sendDelta(app, plugin, time, path, value) {
  app.handleMessage(plugin.id, {
    context: `vessels.${app.selfId}`,
    updates: [
      {
        source: {
          label: plugin.id,
        },
        timestamp: time.toISOString(),
        values: [
          {
            path,
            value,
          },
        ],
      },
    ],
  });
}
function sendCrewNames(app, plugin) {
  const { configuration } = app.readPluginOptions();
  if (!configuration) {
    return;
  }
  sendDelta(app, plugin, new Date(), 'communication.crewNames', configuration.crewNames || []);
}

// AIS proximity tracking
const ALERT_DISTANCE_M = 9260; // 5 nm in meters
const CLEAR_DISTANCE_M = 12964; // 7 nm in meters
const STALE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const aisAlerted = new Map(); // vessel context -> { timestamp, minDistance, name, mmsi }

function calculateCPA(ownPos, ownCog, ownSog, targetPos, targetCog, targetSog) {
  // Flat-earth approximation (accurate within 10 nm)
  const latMid = (ownPos.latitude + targetPos.latitude) / 2;
  const cosLat = Math.cos((latMid * Math.PI) / 180);

  // Relative position in nm
  const dx = (targetPos.longitude - ownPos.longitude) * 60 * cosLat;
  const dy = (targetPos.latitude - ownPos.latitude) * 60;

  // Convert SOG from m/s to nm/min
  const ownSpd = (ownSog * 1.94384) / 60;
  const tgtSpd = (targetSog * 1.94384) / 60;

  // Velocity components (COG in radians, 0=north, clockwise)
  const dvx = tgtSpd * Math.sin(targetCog) - ownSpd * Math.sin(ownCog);
  const dvy = tgtSpd * Math.cos(targetCog) - ownSpd * Math.cos(ownCog);

  const dvSq = dvx * dvx + dvy * dvy;
  if (dvSq < 0.0001) {
    // Parallel courses / stationary — CPA is current distance
    return { cpa: parseFloat(Math.sqrt(dx * dx + dy * dy).toFixed(1)), tcpa: 0 };
  }

  // Time of closest approach in minutes
  const tcpa = -(dx * dvx + dy * dvy) / dvSq;
  if (tcpa < 0) {
    // Vessels diverging — CPA already passed
    return { cpa: parseFloat(Math.sqrt(dx * dx + dy * dy).toFixed(1)), tcpa: 0 };
  }

  const cpaDx = dx + dvx * tcpa;
  const cpaDy = dy + dvy * tcpa;
  return {
    cpa: parseFloat(Math.sqrt(cpaDx * cpaDx + cpaDy * cpaDy).toFixed(1)),
    tcpa: Math.round(tcpa),
  };
}

function checkAISProximity(state, log, app, setStatus) {
  const vessels = app.getPath('vessels');
  if (!vessels) return;

  const selfId = app.selfId;
  const ownPos = state['navigation.position'];
  if (!ownPos) return;
  const ownCog = state['navigation.courseOverGroundTrue'] || 0;
  const ownSog = state['navigation.speedOverGround'] || 0;

  const now = Date.now();

  // Clean stale entries
  aisAlerted.forEach((data, key) => {
    if (now - data.timestamp > STALE_TIMEOUT_MS) {
      aisAlerted.delete(key);
    }
  });

  Object.keys(vessels).forEach((ctx) => {
    if (ctx === selfId || ctx === 'self') return;
    const vessel = vessels[ctx];
    const distNode = vessel.navigation && vessel.navigation.distanceToSelf;
    if (!distNode || distNode.value == null) return;

    const distance = distNode.value; // meters

    const distNm = parseFloat((distance / 1852).toFixed(1));

    if (distance < ALERT_DISTANCE_M && !aisAlerted.has(ctx)) {
      // New vessel entering zone - log approach with predicted CPA
      const name = vessel.name || 'Unknown';
      const mmsi = vessel.mmsi || ctx;

      // Target dynamics for CPA prediction
      const tCog = (vessel.navigation.courseOverGroundTrue && vessel.navigation.courseOverGroundTrue.value) || 0;
      const tSog = (vessel.navigation.speedOverGround && vessel.navigation.speedOverGround.value) || 0;
      const tPos = (vessel.navigation.position && vessel.navigation.position.value) || null;

      let cpa = { cpa: distNm, tcpa: 0 };
      if (tPos && tSog > 0.1) {
        cpa = calculateCPA(ownPos, ownCog, ownSog, tPos, tCog, tSog);
      }

      const text = `AIS: ${name} (${mmsi}) approaching at ${distNm} nm, predicted CPA ${cpa.cpa} nm in ${cpa.tcpa} min`;
      const entry = stateToEntry(state, text, 'auto');
      entry.category = 'navigation';
      entry.ais = {
        mmsi: String(mmsi),
        name: String(name),
        distance: distNm,
        cpa: cpa.cpa,
        tcpa: cpa.tcpa,
      };

      const dateString = new Date(entry.datetime).toISOString().substr(0, 10);
      log.appendEntry(dateString, entry)
        .then(() => {
          setStatus(`AIS proximity: ${name} at ${distNm} nm`);
        })
        .catch((err) => {
          app.error(`Failed to store AIS entry: ${err.message}`);
        });

      aisAlerted.set(ctx, {
        timestamp: now,
        minDistance: distNm,
        name,
        mmsi,
      });
    } else if (aisAlerted.has(ctx)) {
      const tracked = aisAlerted.get(ctx);

      // Update minimum distance if closer
      if (distNm < tracked.minDistance) {
        tracked.minDistance = distNm;
      }

      // Vessel clearing the zone - log actual CPA
      if (distance > CLEAR_DISTANCE_M) {
        const text = `AIS: ${tracked.name} (${tracked.mmsi}) cleared, actual CPA was ${tracked.minDistance} nm`;
        const entry = stateToEntry(state, text, 'auto');
        entry.category = 'navigation';
        entry.ais = {
          mmsi: String(tracked.mmsi),
          name: String(tracked.name),
          distance: distNm,
          cpa: tracked.minDistance,
          tcpa: 0,
        };

        const dateString = new Date(entry.datetime).toISOString().substr(0, 10);
        log.appendEntry(dateString, entry)
          .then(() => {
            setStatus(`AIS cleared: ${tracked.name}, CPA was ${tracked.minDistance} nm`);
          })
          .catch((err) => {
            app.error(`Failed to store AIS entry: ${err.message}`);
          });

        aisAlerted.delete(ctx);
      }
    }
  });
}

module.exports = (app) => {
  const plugin = {};
  let unsubscribes = [];
  let interval;

  plugin.id = 'signalk-logbook';
  plugin.name = 'Logbook';
  plugin.description = 'Semi-automatic electronic logbook for sailing vessels';

  const setStatus = app.setPluginStatus || app.setProviderStatus;

  // The paths we want to listen and collect data for
  const paths = [
    'navigation.state', // Under way/stopped
    'navigation.datetime', // Current time, for automated hourly entries
    'navigation.position',
    'navigation.gnss.type',
    'navigation.headingTrue',
    'navigation.courseOverGroundTrue',
    'navigation.speedThroughWater',
    'navigation.speedOverGround',
    'navigation.log',
    'navigation.course.nextPoint',
    'environment.outside.pressure',
    'environment.wind.directionTrue',
    'environment.wind.speedOverGround',
    'environment.water.swell.state',
    'environment.time.timezoneOffset', // For display timezone
    'propulsion.*.state',
    'propulsion.*.runTime',
    'sails.inventory.*',
    'steering.autopilot.state',
    'communication.crewNames',
    'communication.vhf.channel',
  ];

  // We keep 15min of past state to allow slight backdating of entries
  const buffer = new CircularBuffer(16);

  let log;
  let state = {};

  plugin.start = () => {
    log = new Log(app.getDataDirPath());
    loadVoyageState(app.getDataDirPath());
    const subscription = {
      context: 'vessels.self',
      subscribe: paths.map((p) => ({
        path: p,
        period: 1000,
      })),
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error:${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) {
          return;
        }
        delta.updates.reduce((prev, u) => prev.then(() => {
          if (!u.values) {
            return Promise.resolve();
          }
          return u.values.reduce((
            previousPromise,
            v,
          ) => previousPromise.then(() => processTriggers(v.path, v.value, state, log, app)
            .then((stateUpdates) => {
              if (!stateUpdates) {
                return;
              }
              // Trigger wants to write state
              Object.keys(stateUpdates).forEach((key) => {
                state[key] = stateUpdates[key];
              });
            }, (err) => {
              app.setPluginError(`Failed to store entry: ${err.message}`);
            })
            .then(() => {
              if (u.$source === 'signalk-logbook.XX' && v.path !== 'communication.crewNames') {
                // Don't store our reports into state
                return;
              }
              // Copy new value into state
              state[v.path] = v.value;
            })), Promise.resolve());
        }), Promise.resolve());
      },
    );

    interval = setInterval(() => {
      // Save old state to buffer
      if (!state.datetime) {
        state.datetime = new Date().toISOString();
      }
      if (new Date(state.datetime).getMinutes() === 0) {
        // Store hourly log entry
        processHourly(state, log, app)
          .catch((err) => {
            app.setPluginError(`Failed to store entry: ${err.message}`);
          });
        sendCrewNames(app, plugin);

        // Check for voyage 24h mark
        if (voyageState.active && voyageState.lastDailyTime) {
          const now = new Date();
          const hoursSinceLastDaily = (now - voyageState.lastDailyTime) / (1000 * 60 * 60);
          if (hoursSinceLastDaily >= 24) {
            // Time for a daily voyage entry
            const currentLogM = state['navigation.log'] || 0;
            const currentLog = parseFloat((currentLogM / 1852).toFixed(1));
            const miles24h = currentLog - (voyageState.lastDailyLog || 0);
            const milesFromOrigin = currentLog - (voyageState.startLog || 0);
            const milesToDestination = Math.max(0, (voyageState.distanceTotal || 0) - milesFromOrigin);
            voyageState.dayNumber = (voyageState.dayNumber || 0) + 1;
            voyageState.lastDailyTime = now;
            voyageState.lastDailyLog = currentLog;
            saveVoyageState();

            const entry = stateToEntry(state, `Day ${voyageState.dayNumber} - 24h run: ${miles24h.toFixed(1)} nm`, 'auto');
            entry.category = 'navigation';
            entry.voyage = {
              event: 'daily',
              destination: voyageState.destination,
              distanceTotal: voyageState.distanceTotal,
              miles24h: Math.round(miles24h * 10) / 10,
              milesFromOrigin: Math.round(milesFromOrigin * 10) / 10,
              milesToDestination: Math.round(milesToDestination * 10) / 10,
              dayNumber: voyageState.dayNumber,
            };

            const dateString = now.toISOString().substr(0, 10);
            log.appendEntry(dateString, entry)
              .then(() => {
                setStatus(`Voyage day ${voyageState.dayNumber}: ${miles24h.toFixed(1)} nm in 24h`);
              })
              .catch((err) => {
                app.setPluginError(`Failed to store voyage entry: ${err.message}`);
              });
          }
        }
      }
      // Check AIS proximity (only when underway)
      if (isUnderWay(state)) {
        checkAISProximity(state, log, app, setStatus);
      }

      buffer.enq(state);
      // We can keep a clone of the previous values
      state = {
        ...state,
        datetime: null,
      };
    }, 60000);

    app.registerPutHandler('vessels.self', 'communication.crewNames', (ctx, path, value, cb) => {
      if (!Array.isArray(value)) {
        return {
          state: 'COMPLETED',
          statusCode: 400,
          message: 'crewNames must be an array',
        };
      }
      const faulty = value.findIndex((v) => typeof v !== 'string');
      if (faulty !== -1) {
        return {
          state: 'COMPLETED',
          statusCode: 400,
          message: 'Each crewName must be a string',
        };
      }
      let { configuration } = app.readPluginOptions();
      if (!configuration) {
        configuration = {};
      }
      configuration.crewNames = value;
      app.savePluginOptions(configuration, (err) => {
        if (err) {
          cb({
            state: 'COMPLETED',
            statusCode: 500,
            message: err.message,
          });
          return;
        }
        sendCrewNames(app, plugin);
        cb({
          state: 'COMPLETED',
          statusCode: 200,
        });
      });
      return {
        state: 'PENDING',
      };
    });
    sendCrewNames(app, plugin);

    setStatus('Waiting for updates');
  };

  plugin.registerWithRouter = (router) => {
    function handleError(error, res) {
      if (error.code === 'ENOENT') {
        res.sendStatus(404);
        return;
      }
      if (error.stack && error.message) {
        app.debug(error.stack);
        res.status(400);
        res.send({
          message: error.stack,
        });
        return;
      }
      app.debug(error.message);
      res.sendStatus(500);
    }
    // Voyage state endpoint
    router.get('/voyage', (req, res) => {
      res.contentType('application/json');
      res.send(JSON.stringify(voyageState));
    });

    router.get('/logs', (req, res) => {
      res.contentType('application/json');
      log.listDates()
        .then((dates) => {
          res.send(JSON.stringify(dates));
        }, (e) => handleError(e, res));
    });
    router.post('/logs', (req, res) => {
      res.contentType('application/json');
      let stats;
      if (req.body.ago > buffer.size()) {
        // We don't have history that far, sadly
        res.sendStatus(404);
        return;
      }
      if (buffer.size() > 0) {
        stats = buffer.get(req.body.ago);
      } else {
        stats = {
          ...state,
        };
      }
      const author = parseJwt(req.cookies.JAUTHENTICATION).id;
      const data = stateToEntry(stats, req.body.text, author);
      if (req.body.category) {
        data.category = req.body.category;
      } else {
        data.category = 'navigation';
      }
      if (req.body.observations) {
        data.observations = {
          ...req.body.observations,
        };
        if (!Number.isNaN(Number(data.observations.seaState))) {
          sendDelta(
            app,
            plugin,
            new Date(data.datetime),
            'environment.water.swell.state',
            data.observations.seaState,
          );
        }
      }
      if (req.body.position) {
        data.position = {
          ...req.body.position,
        };
        // TODO: Send delta on manually entered position?
      }
      // Sail configuration and sailing data
      if (req.body.sails) {
        data.sails = { ...req.body.sails };
      }
      if (req.body.tack) {
        data.tack = req.body.tack;
      }
      if (req.body.pointOfSail) {
        data.pointOfSail = req.body.pointOfSail;
      }
      if (req.body.heel !== undefined) {
        data.heel = req.body.heel;
      }
      if (req.body.heelSide) {
        data.heelSide = req.body.heelSide;
      }
      // Voyage tracking
      if (req.body.voyage) {
        data.voyage = { ...req.body.voyage };
        // Handle voyage state changes
        if (req.body.voyage.event === 'start') {
          voyageState = {
            active: true,
            startTime: new Date(data.datetime),
            startLog: data.log || 0,
            destination: req.body.voyage.destination,
            distanceTotal: req.body.voyage.distanceTotal || 0,
            lastDailyTime: new Date(data.datetime),
            lastDailyLog: data.log || 0,
            dayNumber: 0,
          };
          saveVoyageState();
        } else if (req.body.voyage.event === 'end') {
          voyageState = { active: false };
          saveVoyageState();
        }
      }
      const dateString = new Date(data.datetime).toISOString().substr(0, 10);
      log.appendEntry(dateString, data)
        .then(() => {
          setStatus(`Manual log entry: ${req.body.text}`);
          res.sendStatus(201);
        }, (e) => handleError(e, res));
    });
    router.get('/logs/:date', (req, res) => {
      res.contentType('application/json');
      log.getDate(req.params.date)
        .then((date) => {
          res.send(JSON.stringify(date));
        }, (e) => handleError(e, res));
    });
    router.get('/logs/:date/:entry', (req, res) => {
      res.contentType('application/json');
      if (req.params.entry.substr(0, 10) !== req.params.date) {
        res.sendStatus(404);
        return;
      }
      log.getEntry(req.params.entry)
        .then((entry) => {
          res.send(JSON.stringify(entry));
        }, (e) => handleError(e, res));
    });
    router.put('/logs/:date/:entry', (req, res) => {
      res.contentType('application/json');
      if (req.params.entry.substr(0, 10) !== req.params.date) {
        res.sendStatus(404);
        return;
      }
      const entry = {
        ...req.body,
      };
      const author = parseJwt(req.cookies.JAUTHENTICATION).id;
      if (author && !entry.author) {
        entry.author = author;
      }
      log.writeEntry(entry)
        .then(() => {
          res.sendStatus(200);
        }, (e) => handleError(e, res));
    });
    router.delete('/logs/:date/:entry', (req, res) => {
      if (req.params.entry.substr(0, 10) !== req.params.date) {
        res.sendStatus(404);
        return;
      }
      log.deleteEntry(req.params.entry)
        .then(() => {
          res.sendStatus(204);
        }, (e) => handleError(e, res));
    });
  };

  plugin.stop = () => {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    clearInterval(interval);
    aisAlerted.clear();
  };

  plugin.schema = {
    type: 'object',
    properties: {
      crewNames: {
        type: 'array',
        default: [],
        title: 'Crew list',
        items: {
          type: 'string',
        },
      },
      displayTimeZone: {
        type: 'string',
        default: '',
        title: 'Display time zone (fallback if SignalK timezone not available)',
        description: 'e.g. America/Toronto, Europe/London, UTC. Leave empty to use SignalK environment.time.timezoneOffset',
      },
    },
  };

  plugin.getOpenApi = () => openAPI;

  return plugin;
};
