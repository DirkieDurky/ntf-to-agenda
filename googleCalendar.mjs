import { google } from "googleapis";
import readline from "readline";
import { formatDate } from "./helpers.mjs";
import 'dotenv/config';

const REDIRECT_URI = "http://localhost";

export async function authorizeOnce() {
    const oauth2Client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/calendar'],
    });

    console.log(formatDate(new Date()), "|", 'Authorize this app by visiting this url:', authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    await new Promise((resolve) => {
        rl.question('Enter the code from that page here (Note: The page won\'t load. Just copy the code from the url bar. ' +
            'Everything after "code=" up until the first "&". Replace the %2F at the start with a slash. ' +
            'The code should start with "4/"): ', async (code) => {
                rl.close();
                const { tokens } = await oauth2Client.getToken(code);
                console.log(`Refresh token (Enter this in your .env): ${tokens.refresh_token}`);
                resolve();
            });
    });
}

export async function authorizeOnStartup() {
    const oauth2Client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) {
            console.log('Access token refreshed, expires at', new Date(tokens.expiry_date).toString());
        }
    });

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

    console.log(formatDate(new Date()), "|", `${events.length} events found to delete`);

    await Promise.all(
        events.map((event) =>
            calendarApi.events.delete({
                calendarId,
                eventId: event.id,
            })
        )
    );
}

export async function createEvent(calendarApi, calendarId, shift) {
    const event = {
        summary: `Kwalitaria - ${shift.type}`,
        start: {
            dateTime: shift.startDateTime,
            timeZone: "Europe/Amsterdam",
        },
        end: {
            dateTime: shift.endDateTime,
            timeZone: "Europe/Amsterdam",
        },
    };

    try {
        const response = await calendarApi.events.insert({
            calendarId: calendarId,
            resource: event,
        });
        console.log(formatDate(new Date()), "|", 'Event successfully created!');
        console.log(formatDate(new Date()), "|", 'View Event:', response.data.htmlLink);
    } catch (error) {
        console.error(formatDate(new Date()), "|", 'Error creating event:', error.message);
    }
}
