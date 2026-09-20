# Oracle Object Storage for kaptured — setup notes

## What exists now

A private bucket called **kaptured-storage** in the **India West (Mumbai)** region, Standard tier, object versioning off, auto-tiering off, object events off, Oracle-managed encryption. It sits in the root compartment (`namankasliwal`) of the tenancy, and it stays private unless someone explicitly turns on public access on the bucket.

Alongside it there is a customer secret key named **kaptured-s3** on the user `nkjaipur21@gmail.com`. That key pair is what the S3 libraries authenticate with — it is not an OCI API signing key, and the two are not interchangeable.

## The three values everything else is built from

Bucket is `kaptured-storage`, namespace is `bmnn5bpwmyri`, region is `ap-mumbai-1`. The namespace is per-tenancy and never changes; the region string is the one Oracle uses internally for Mumbai, not the display name.

The S3 endpoint is those first two stitched together:

```
https://bmnn5bpwmyri.compat.objectstorage.ap-mumbai-1.oci.customer-oci.com
```

## Wiring it into a Node app

```bash
npm install @aws-sdk/client-s3
```

```js
import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});
```

`forcePathStyle: true` matters — Oracle's compatibility layer does not do virtual-host-style bucket addressing, so without it every call fails DNS resolution. From there `PutObject`, `GetObject`, `DeleteObject`, `ListObjectsV2` and `HeadObject` all behave as they do on AWS. Presigned URLs work too, which is the usual way to hand a client a temporary download link without opening the bucket.

## What to tell Claude Code or Cursor

> Oracle Object Storage is being used through its S3-compatible API. Use the AWS SDK with the custom `S3_ENDPOINT` from the environment and `forcePathStyle: true`. Store generated files in the configured bucket. Never expose the secret key client-side — uploads from the browser go through a presigned URL issued by the server.

## Handling the credentials

The secret key is shown exactly once at creation and Oracle keeps no copy. If it is ever lost, delete the `kaptured-s3` entry under Profile → My profile → Tokens and keys and generate a fresh one; there is no recovery path. Keep `oracle-storage.env` out of git, and put the same five values into whatever secret store the deployment uses rather than shipping the file.

A tenancy can hold two customer secret keys per user at a time, so rotation works by generating the second key, switching the app over, then deleting the old one.

## Free tier ceiling

The account is on a Free Trial: 10 GiB of Object Storage and 10 GiB of Archive are always-free, and the console warns that data beyond 20 GiB is deleted if the trial ends without an upgrade. Worth watching once real render output starts landing in the bucket.
