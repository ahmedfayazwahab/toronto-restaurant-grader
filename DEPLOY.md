# Deploying the Restaurant Grader to ahmedfayazwahab.ca/restaurantgrader

How it fits together:

```
Browser -> CloudFront (your portfolio distribution)
            |- /restaurantgrader/*       -> S3 (static pages: index, report, terms, privacy, credits, css)
            |- /restaurantgrader/api/*   -> Lambda Function URL (the app: search, scans, limits)
                                              |- S3 private data bucket (cached reports, 30-day expiry)
                                              |- DynamoDB table (daily scan counters, 2-day expiry)
```

Your everyday CLI user is deliberately limited, so Parts A and B are done in the AWS console as an admin.
Everything is in us-east-1.

## Before you start
- Zip to upload later: `app/dist/restaurantgrader-lambda.zip` (rebuild any time with `bash scripts/package.sh`).
- A random secret is already saved at `app/infra/.origin-secret`. Copy it to your clipboard without displaying it:
  ```
  pbcopy < "app/infra/.origin-secret"
  ```
- Your keys are in the project's `.env` file. To copy one to the clipboard without displaying it (change the name for each key):
  ```
  grep '^GOOGLE_API_KEY=' .env | cut -d= -f2- | tr -d '\n' | pbcopy
  ```

## Part A: Create the backend (CloudFormation)

1. **CloudFormation console** (region us-east-1) -> Create stack -> With new resources -> Upload a template file -> choose `infra/template.yaml`.
   - Stack name: `restaurant-grader`
   - `OriginSecret`: paste the secret (from `pbcopy` above)
   - `GoogleApiKey`, `PageSpeedApiKey`, `OpenAIApiKey`, `BraveApiKey`: paste each from your `.env`
   - `ContactEmail`: the email to show on the legal pages (leave empty to show a link to your portfolio instead)
   - Leave the limits at 8 scans per visitor per day and 80 per day overall (change if you like)
   - Tick "I acknowledge that CloudFormation might create IAM resources", then Create.
2. When the stack shows CREATE_COMPLETE: **Lambda console** -> `restaurant-grader` -> Code -> Upload from -> .zip file -> choose `app/dist/restaurantgrader-lambda.zip` -> Save.
3. Same function -> Configuration -> Function URL -> Create function URL.
   - Auth type: **NONE**
   - Invoke mode: **RESPONSE_STREAM**
   - Save, then copy the URL (looks like `https://abc123.lambda-url.us-east-1.on.aws/`).
   - It is public, but the app returns 403 to any request that lacks the secret header, so only CloudFront gets through.
4. Check it from your terminal (expect a 403 saying Forbidden, which means the app is live and protected):
   ```
   curl -s https://<your-function-url>/restaurantgrader/api/config
   ```

## Part B: Connect it in CloudFront (your portfolio distribution)

5. **Origin.** Distribution -> Origins -> Create origin
   - Origin domain: the Function URL host only (no `https://`, no trailing slash)
   - Protocol: HTTPS only
   - Response timeout: 60 seconds
   - Add custom header: name `x-origin-verify`, value = the same secret (`pbcopy < app/infra/.origin-secret`)
6. **Origin request policy.** CloudFront -> Policies -> Origin request -> Create
   - Name: `grader-origin`
   - Headers: add the CloudFront header `CloudFront-Viewer-Address`
   - Query strings: All. Cookies: None.
   - (This lets the app count scans per visitor.)
7. **Behavior.** Distribution -> Behaviors -> Create behavior
   - Path pattern: `/restaurantgrader/api/*`
   - Origin: the one from step 4
   - Viewer protocol policy: Redirect HTTP to HTTPS
   - Allowed methods: GET, HEAD
   - Cache policy: **CachingDisabled**
   - Origin request policy: `grader-origin`
   - Compress objects: No
   - Make sure it sits above the default behavior in the list.
8. **Index page rewrite.** CloudFront -> Functions -> Create function `restaurantgrader-index`, paste `infra/cloudfront-function.js`, Publish, then attach it to the **default** behavior as a Viewer request function.
   If the default behavior already has a function, merge the lines into it instead.

## Part C: Put the website files in S3

9. Either run (uses your deploy CLI user; fill in your portfolio bucket name and CloudFront distribution ID):
   ```
   bash scripts/deploy-site.sh <portfolio-bucket> <distribution-id>
   ```
   or upload the contents of `app/public/` to the portfolio bucket under the prefix `restaurantgrader/` in the S3 console, then create an invalidation for `/restaurantgrader/*`.

## Part D: Check it works

```
curl -s https://ahmedfayazwahab.ca/restaurantgrader/api/config
curl -s "https://ahmedfayazwahab.ca/restaurantgrader/api/search?q=tim+hortens"
```
Then open https://ahmedfayazwahab.ca/restaurantgrader/ , search a restaurant, run one scan, and open Terms, Privacy and Data sources from the footer.
- A 403 from the API means the `x-origin-verify` header on the origin doesn't match the stack's OriginSecret.
- A scan that stops after about 30 seconds means the origin's Response timeout is still at the default. Set it to 60.

## Part E: Cost protection checklist
- Google Cloud: budget alert on the billing account, plus lower per-API quotas for Places API (New) and PageSpeed Insights in each project that holds a key.
- OpenAI: set a monthly usage limit.
- Brave: the $10/month limit you set.
- AWS: Billing -> Budgets -> a small monthly budget with an email alert. In the Lambda console you can also set Reserved concurrency to 3-5 (only if your account's limit allows it).
- The app itself limits each visitor to 8 new scans a day and the whole service to 80. Change these in the Lambda's environment variables (`LIMIT_SCANS_PER_IP_PER_DAY`, `LIMIT_SCANS_PER_DAY`).

## Updating later
- New backend code: `bash scripts/package.sh`, upload the zip, then Lambda -> Code -> Upload from -> .zip file (or S3 location).
- New website files: `scripts/deploy-site.sh` again.
- New key: Lambda -> Configuration -> Environment variables. (Environment variables are readable by AWS admins; Secrets Manager is the next step up if you want that.)

## Not verified from here
I could only test the app locally and the Lambda handler with a stand-in for AWS's streaming helper. I could not run CloudFormation, create the Function URL, or test through CloudFront, because the CLI user has no access to those. Console menus may be labelled slightly differently than described above.
