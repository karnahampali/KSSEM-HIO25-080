# Intelli-Hire portal MVP

# Here is a basic showcase on how the portal works : 

https://github.com/user-attachments/assets/51fbf4d1-7e6d-4f88-be1c-8ff34955d5da

# Features of IntelliHire
IntelliHire automates resume screening using AI-based text analysis. It has two portals
1. Candidate Portal
2. Recruiter Portal

To access the candidate portal for the first time, the user has to sign up using their email ID and password.
Then the user will be prompted to upload their Resumes, LinkedIn and Certificates.
The user can edit the uploaded/entered files later on by logging in.

The recruiter portal requires authentication to login. Once logged in, the recruiter will have access to all the candidates,
whose analysis can be done by entering the work description and a single click. The recruiter will also have access to multiple
other features such as *Quarantining* a user, *Scheduling a meeting* with the user, and sorting the candidates based on the scores
required for the recruiter (Eg - 90+ only). They also share the power to remove the user from the portal.

# How to run thhe project?
1) clone the project in vscode using git clone https://github.com/karnahampali/KSSEM-HIO25-080
2) run the command npm install
3) get a gemini api key and add it to .env file, also do the same for enabling mails.
4) use the command node server.js to start the server.
5) the project will be hosted on the local port given.

# After MVP?
We plan to continue making this project with better ideas which simply couldn't be implemented in 24 hours such as
1) Certificate verification through their ID's.
2) Background verification of candidates through Government ID's.
3) A seperate Admin-only portal for monitoring the recruiters.
4) Removing manual biasing by hiding the candidate's name from the recruiter. (Can be set in Admin portal)


