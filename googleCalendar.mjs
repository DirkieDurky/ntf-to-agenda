import { google } from "googleapis";
import readline from "readline";
import 'dotenv/config';

const REDIRECT_URI = "http://localhost";

export async function googleCalendarAuthorize() {
    const oauth2Client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
    });

    console.log('Authorize this app by visiting this url:', authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question('Enter the code from that page here (Note: The page won\'t load. Just copy the code from the url bar. ' +
            'Everything after "code=" up until the first "&". Replace the %2F at the start with a slash. ' +
            'The code should start with "4/"): ', async (code) => {
                rl.close();
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                resolve(oauth2Client);
            });
    });
}

export async function createCalendarEvent(shift, auth) {
    const calendar = google.calendar({ version: 'v3', auth });

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
        const response = await calendar.events.insert({
            calendarId: process.env.CALENDAR_ID,
            resource: event,
        });
        console.log('Event successfully created!');
        console.log('View Event:', response.data.htmlLink);
    } catch (error) {
        console.error('Error creating event:', error.message);
    }
}
