import { google } from "googleapis";
import readline from "readline";
import config from './config.json' with { type: 'json' };

const REDIRECT_URI = "http://localhost";

export async function generateRefreshToken() {
    const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/calendar'],
    });

    console.log('Authorize this app by visiting this url:', authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    await new Promise((resolve) => {
        rl.question('Enter the code from that page here (Note: The page won\'t load. Just copy the code from the url bar. ' +
            'Everything after "code=" up until the first "&". Replace the %2F at the start with a slash if it isn\'t one already. ' +
            'The code should start with "4/"): ', async (code) => {
                rl.close();
                const { tokens } = await oauth2Client.getToken(code);
                console.log(`Refresh token (Enter this in your .env): ${tokens.refresh_token}`);
                resolve();
            });
    });
}

export async function authorizeGoogleAPI() {
    const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: config.refreshToken });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) {
            console.log('Access token refreshed, expires at', new Date(tokens.expiry_date).toString());
        }
    });

    try {
        const res = await oauth2Client.getAccessToken();
    } catch (err) {
        if (err.response.data.error === "invalid_grant") {
            console.error("Refresh token has been expired or revoked. Please make a new one.");
            await generateRefreshToken();
            process.exit(1);
        } else {
            console.log("Something went wrong getting an access token:");
            console.log(err);
        }
    }

    return google.calendar({ version: 'v3', auth: oauth2Client });
}

export async function clearWeek(calendarApi, calendarId, startDate, endDate) {
    const res = await calendarApi.events.list({
        calendarId,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
    });

    const events = res.data.items;
    if (!events || events.length === 0) return;

    console.log(`${events.length} events found to delete`);

    await Promise.all(
        events.map((event) =>
            calendarApi.events.delete({
                calendarId,
                eventId: event.id,
            })
        )
    );
}

export async function createEvent(calendarApi, calendarId, startDateTime, endDateTime, summary, description) {
    const event = {
        summary: summary,
        start: {
            dateTime: startDateTime,
        },
        end: {
            dateTime: endDateTime,
        },
        description: description
    };

    try {
        const response = await calendarApi.events.insert({
            calendarId: calendarId,
            resource: event,
        });
        console.log('Event successfully created!');
        console.log('View Event:', response.data.htmlLink);
    } catch (error) {
        console.error('Error creating event:', error.message);
    }
}
