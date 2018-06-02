const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment-timezone');

admin.initializeApp(functions.config().firebase);

const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const cors = require('cors')({
  origin: true,
});

// Use firebase functions:config:set to configure your googleapi object:
const CONFIG_CLIENT_ID = functions.config().googleapi.client_id;
const CONFIG_CLIENT_SECRET = functions.config().googleapi.client_secret;
const CONFIG_DATA_PATH = 'testdata';
const DB_TOKEN_PATH = '/api_tokens';
const FUNCTIONS_REDIRECT = `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com/oauthcallback`;

// setup for authGoogleAPI
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const functionsOauthClient = new OAuth2Client(CONFIG_CLIENT_ID, CONFIG_CLIENT_SECRET, FUNCTIONS_REDIRECT);

// OAuth token cached locally.
let oauthTokens = null;
var timeZone = null, calendarId = null;
var openingHours = [];
let dayOpen = null, dayClosed = null;

// checks if oauthTokens have been loaded into memory, and if not, retrieves them
function getAuthorizedClient() {
  if (oauthTokens) {
    return Promise.resolve(functionsOauthClient);
  }
  return admin.firestore().doc('team/koenvdb').get().then((doc) => {
    oauthTokens = doc.data().google_tokens;
    functionsOauthClient.setCredentials(oauthTokens);
    return functionsOauthClient;
  });
}

// Request Google tokens
exports.authgoogleapi = functions.https.onRequest((req, res) => {
  res.set('Cache-Control', 'private, max-age=0, s-maxage=0');
  res.redirect(functionsOauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  }));
});

// after you grant access, you will be redirected to this Function
// this Function stores the tokens to your Firebase database
exports.oauthcallback = functions.https.onRequest((req, res) => {
  res.set('Cache-Control', 'private, max-age=0, s-maxage=0');
  const code = req.query.code;
  functionsOauthClient.getToken(code, (err, tokens) => {
    // Now tokens contains an access_token and an optional refresh_token. Save them.
    if (err) {
      return res.status(400).send(err);
    }
    const tokenMap = {google_tokens: tokens};
    return admin.firestore().doc('team/koenvdb').set(tokenMap, {merge: true})
        .then(() => {
          return res.status(200).send('Google app credentials saved successfully!');
        });
  });
});

function setGlobalVars(){
    // get calendar variables from database
    return admin.firestore().doc('team/koenvdb').get().then((doc) => {
        timeZone = doc.data().calendar.timeZone;
        calendarId = doc.data().calendar.id;
        openingHours = doc.data().openingHours;
        return;
    }).catch(error => {
        return error;
    });
}

function freeBusyRequest(timeStart, timeEnd){
    
    let config = {
            // https://github.com/axios/axios#request-config
            url: 'https://www.googleapis.com/calendar/v3/freeBusy',
            method: 'post',
            headers: {
              'Content-Type': 'application/json'
            },
            data: {
                // 2018-05-17T08:00:00+02:00
              timeMin: timeStart,
              timeMax: timeEnd,
              timeZone: timeZone,
              items: [
                {
                  id: calendarId
                }
              ]
            }
    }
        
    return new Promise((resolve, reject) => {
        getAuthorizedClient().then((client) => {
            client.request(config).then((answer) => {
                let busySlots = answer.data.calendars[calendarId].busy;
                resolve(busySlots);
            });
        });
    });
}

// visit the URL for this Function to request free days in given month
exports.getFreeDays = functions.https.onRequest((req, res) => {

    return cors(req, res, () => {
        
        let timeStart = req.query.timeStart;
        let timeEnd = req.query.timeEnd;
        
        setGlobalVars().then(() => {
            return freeBusyRequest(timeStart, timeEnd);
        }).then((busySlots) => {
            return freeFromBusy(busySlots,timeStart,timeEnd);
        }).then((freeSlots) => {
            return freeDays(freeSlots);
        }).then((freeDays) => {
            return res.status(200).send(freeDays);
        }).catch((error) => {
            return res.status(400).send(error);
        });

    });

});

// visit the URL for this Function to request free days in given month
exports.getFreeTimeSlots = functions.https.onRequest((req, res) => {

    return cors(req, res, () => {
        
        let timeStart = req.query.timeStart;
        let timeEnd = req.query.timeEnd;
        
        setGlobalVars().then(() => {
            return freeBusyRequest(timeStart, timeEnd);
        }).then((busySlots) => {
            return freeFromBusy(busySlots,timeStart,timeEnd);
        }).then((freeSlots) => {
            return freeTimeSlots(freeSlots);
        }).then((timeSlots) => {
            return res.status(200).send(timeSlots);
        }).catch((error) => {
            return res.status(400).send(error);
        });

    });

});

function freeFromBusy(events, startDate, endDate) {
   freeSlots = [];
   for (var i = 0, len = events.length; i < len; i++) { //calculate free from busy times
       if (i == 0 && startDate < events[i].start) {
           freeSlots.push({start: startDate, end: events[i].start});
       }
       else if (i == 0) {
           startDate = events[i].end;
       }
       else if (events[i - 1].end < events[i].start) {
           freeSlots.push({start: events[i - 1].end, end: events[i].start});
       }

       if (events.length == (i + 1) && events[i].end < endDate) {
           freeSlots.push({start: events[i].end, end: endDate});
       }
   }
   if (events.length == 0) {
       freeSlots.push({start: startDate, end: endDate});
   }
   return freeSlots;
}

function freeDays(freeSlots) {
    var temp = {}, days = [], interval = 15;
    
    freeSlots.forEach(function(free, index) {
        
        var freeStart = moment.tz(free.start, timeZone), freeEnd = moment.tz(free.end, timeZone);
        var freeStartDate = moment(freeStart.format('YYYY-MM-DD')), freeEndDate = moment(freeEnd.format('YYYY-MM-DD'));
        var daysSpan = freeEndDate.diff(freeStartDate, 'days'); // = 0 when starts and ends on same day
        
        for(i=0; i < daysSpan+1; i++){
            var day = getDayOpeningHours(freeStartDate, i);
            if (day.open == null || days.indexOf(day.open.format('YYYY-MM-DD')) >= 0) continue; // skip closed or already added day
            
            freeStart = moment.tz(free.start, timeZone);
            freeEnd = moment.tz(free.end, timeZone);
            if (freeStart.isBefore(day.open)) {
                freeStart = day.open;
            }
            if (freeEnd.isAfter(day.closed)) {
                freeEnd = day.closed;
            }
            
            var freeRange = freeEnd.diff(freeStart, 'minutes');
            if (freeRange < interval) continue;
            else days.push(day.open.format('YYYY-MM-DD')); // end:temp.en
            
        }
        
    })
    
    return days;
}

function freeTimeSlots(freeSlots) {
    var temp = {}, timeSlots = [], interval = 15;
    
    freeSlots.forEach(function(free, index) {
        
        var freeStart = moment.tz(free.start, timeZone), freeEnd = moment.tz(free.end, timeZone);
        var freeStartDate = moment(freeStart.format('YYYY-MM-DD')), freeEndDate = moment(freeEnd.format('YYYY-MM-DD'));
        var daysSpan = freeEndDate.diff(freeStartDate, 'days'); // = 0 when starts and ends on same day
        
        for(i=0; i < daysSpan+1; i++){
            var day = getDayOpeningHours(freeStartDate, i);
            if (day.open == null) continue; // skip closed day
            
            if (freeStart.isBefore(day.open)) {
//                freeStart = day.open;
//                console.log("freeStart.isBefore(day.open)");
            }
            if (freeEnd.isAfter(day.closed)) {
//                freeEnd = day.closed;
//                console.log("freeEnd.isAfter(day.closed)");
            }
            
            var freeRange = freeEnd.diff(freeStart, 'minutes');
            if (freeRange <= 0) continue;
            
            var j = 0;
            while(freeRange>=interval) { // 11 + 4 + 2 >= 0
                temp.e = freeStart.clone();
                temp.e.add(((j+1) * interval), 'minutes');
                temp.s = freeStart.clone();
                temp.s.add((j * interval), 'minutes');
                if(temp.s.isSameOrAfter(day.open) && temp.e.isSameOrBefore(day.closed)) {
                    timeSlots.push({start:temp.s.format('YYYY-MM-DD HH:mm')}); // end:temp.en
                    temp = {};
                }
                freeRange-=15;
                j++;
            } 
        }
        
    })
    
    return timeSlots;
}

// moment YYYY-MM-DD and offset in number of days
function getDayOpeningHours(date, offset) {
    var currentDate = date.clone();
    var dayNumber = currentDate.add(offset, 'days').day();
    var day = {open: null, closed: null};
    let open = openingHours[dayNumber].open, closed = openingHours[dayNumber].closed;
    // check for 'null' values
    if (open && closed) {
        open = currentDate.hours(open.slice(0,2)).minutes(open.slice(3,5)).format('YYYY-MM-DDTHH:mm');
        closed = currentDate.hours(closed.slice(0,2)).minutes(closed.slice(3,5)).format('YYYY-MM-DDTHH:mm');
        day.open = moment.tz(open, timeZone);
        day.closed = moment.tz(closed, timeZone);
    }
    
    return day;
}


exports.insertEvent = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {

      setGlobalVars().then(() => {
          return getAuthorizedClient();
      }).then((client) => {

      let config = {
            // https://github.com/axios/axios#request-config
            url: 'https://www.googleapis.com/calendar/v3/calendars/' + calendarId + '/events',
            method: 'post',
            headers: {
                'Content-Type': 'application/json'
            },
            data: {
              start: {
                dateTime: "2018-05-22T10:30:00+02:00"
              },
              end: {
                dateTime: "2018-05-22T15:30:00+02:00"
              },
              summary: "John Doe",
              description: "John Doe heeft last van pijn"

            }
      }

      client.request(config).then((answer) => {

          return res.status(answer.status).send(answer.data);

      });

  });

  });
});
