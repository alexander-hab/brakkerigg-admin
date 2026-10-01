# Brakkerigg

Netlify-nettside med innlogging, booking og romoversikt.

## Sperre og åpne rom

Som admin finner du **Tilgjengelighet for rom** nederst på adminsiden.
Velg rommet og trykk **Gjør utilgjengelig** når det ikke er klart for utleie.
Velg samme rom og trykk **Gjør tilgjengelig** når det er klart igjen.

Sperrede rom vises røde og som **Utleid** for vanlige brukere. De fjernes fra
romvalget og kan ikke bookes eller forespørres. Admin ser **Utilgjengelig**.
Sperren gjelder alle datoer frem til admin åpner rommet igjen. Faktiske bookinger
beholdes; å åpne et rom opphever ikke en eksisterende booking.
Tidligere forespørsler kan avslås mens rommet er sperret, og kan godkjennes etter
at det er åpnet igjen. Eksisterende bookinger kan korrigeres eller forkortes,
men ikke forlenges mens rommet er sperret.

## Database og publisering

Etter utrulling initialiserer den første rom- eller bookingforespørselen
`units.is_available` (standardverdi `true`) og databasetriggere som håndhever
bookingsperren. Initialiseringen er automatisk og kan kjøres flere ganger.
Databasetilkoblingen må kunne endre de eksisterende tabellene og opprette
PL/pgSQL-funksjoner og triggere. Bruk den samme Netlify/Neon-tilkoblingen som før.

Adminrettigheter leses fra de tildelte rollene i `app_metadata.roles` eller
`app_metadata.authorization.roles`. Selvredigerbare brukerfelt gir ikke
adminrettigheter.

## Tester

Med Node.js 22 eller nyere:

```sh
npm ci
npm test
```

Testene kjører Netlify-funksjonene mot en lokal PostgreSQL-testdatabase via
PGlite. De trenger ingen produksjonsdatabase, innlogging eller e-postnøkler.
De dekker tilgangskontroll, sperring/gjenåpning, bookinger, forespørsler,
godkjenning og et rom som blir sperret etter at tilgjengeligheten ble sjekket.
